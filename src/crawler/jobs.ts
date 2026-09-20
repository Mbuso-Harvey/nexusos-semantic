/**
 * Crawl job manager (R5) — async substrate production for MCP agents.
 *
 * `crawl_start` runs the orchestrator as a background job and publishes the
 * substrate **atomically**: the crawl writes into a staging directory and the
 * finished directory is renamed into place only on success. A failed or
 * cancelled crawl never leaves a loadable partial substrate — `serve` and
 * `GraphStore.load()` refuse substrates whose `crawl.cmeta.json` says
 * `complete: false`, and a partial directory never exists at the output path
 * at all.
 *
 * Producer model (agreed with Cosmos): the handle records WHO produced the
 * substrate. Provenance only means something if the producer is accountable —
 * `mode: "delegated"` means an agent triggered the crawl under an
 * operator-issued authorization (the enforcement gateway gates `crawl_start`
 * as the `crawl` operation, impact `modify`); `mode: "operator"` means a
 * human/CI produced it. Trust policy per mode is the consumer's decision.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Crawler, DEFAULT_BUDGET, type CrawlBudget } from "./orchestrator.js";
import { BiDiSession } from "../bidi-client/session.js";
import { Graph } from "../graph/graph.js";
import { GraphStore, computeGraphHash } from "../store/store.js";

export type CrawlJobState = "running" | "complete" | "failed" | "cancelled";

/** Who produced the substrate, recorded on the handle for trust policy. */
export interface CrawlJobProducer {
  actorId: string;
  /** Authorization under which the job was admitted (may be null for operator runs). */
  authorizationId: string | null;
  /** `"operator"` = human/CI produced; `"delegated"` = agent produced under authorization. */
  mode: "operator" | "delegated";
}

/** The crawl job handle returned by `crawl_start` and `crawl_status`. */
export interface CrawlJobHandle {
  jobId: string;
  /** sha256(rootUrl|scope|maxPages|outputDir) — converges duplicate job requests. */
  idempotencyKey: string;
  state: CrawlJobState;
  /** The ONLY thing `nexus serve --graph` needs. Published atomically on success. */
  outputDir: string;
  rootUrl: string;
  budget: CrawlBudget;
  producer: CrawlJobProducer;
  /** sha256 of the published graph.json bytes; null until complete. */
  graphHash: string | null;
  pages: { crawled: number; failed: number };
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface StartCrawlJobOptions {
  rootUrl: string;
  /** Required — there is no default substrate, by the same rule as `serve`. */
  outputDir: string;
  maxPages?: number;
  scope?: "same-origin" | "same-site" | "any";
  producer: CrawlJobProducer;
  /** R4: BiDi endpoint for the crawl's own session (default geckodriver 4444). */
  webDriverBase?: string;
}

export class CrawlJobError extends Error {
  constructor(
    public readonly code: "SUBSTRATE_EXISTS" | "JOB_NOT_FOUND" | "JOB_NOT_RUNNING",
    message: string,
  ) {
    super(message);
  }
}

interface InternalJob {
  handle: CrawlJobHandle;
  stagingDir: string;
  cancelRequested: boolean;
  running: Promise<void>;
}

export class CrawlJobManager {
  private jobs = new Map<string, InternalJob>();

  /**
   * Start a crawl job. Returns immediately with a handle in `running` state.
   * Duplicate requests with the same idempotency key converge on the running
   * job instead of crawling twice (multi-node failover must not multiply work).
   * The output directory is never overwritten: if it already exists, the start
   * fails with SUBSTRATE_EXISTS — producing a substrate is an explicit act.
   */
  start(opts: StartCrawlJobOptions): CrawlJobHandle {
    const outputDir = resolve(opts.outputDir);
    // Producing a substrate is an explicit act: never overwrite, never
    // default. An existing directory is a hard error, not a merge.
    if (existsSync(outputDir)) {
      throw new CrawlJobError(
        "SUBSTRATE_EXISTS",
        `outputDir ${outputDir} already exists — pick a new outputDir or remove the old substrate first (no overwrites, no implicit defaults).`,
      );
    }
    const maxPages = opts.maxPages ?? DEFAULT_BUDGET.maxPages;
    const scope = opts.scope ?? "same-origin";

    const idempotencyKey = createHash("sha256")
      .update([opts.rootUrl, scope, maxPages, outputDir].join("|"))
      .digest("hex")
      .slice(0, 16);

    for (const job of this.jobs.values()) {
      if (job.handle.idempotencyKey === idempotencyKey && job.handle.state === "running") {
        return job.handle;
      }
    }

    const jobId = `crawl-${randomBytes(8).toString("hex")}`;
    const stagingDir = `${outputDir}.partial-${jobId}`;
    const handle: CrawlJobHandle = {
      jobId,
      idempotencyKey,
      state: "running",
      outputDir,
      rootUrl: opts.rootUrl,
      budget: { ...DEFAULT_BUDGET, maxPages },
      producer: { ...opts.producer },
      graphHash: null,
      pages: { crawled: 0, failed: 0 },
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    const job: InternalJob = { handle, stagingDir, cancelRequested: false, running: null as unknown as Promise<void> };
    job.running = this.run(job, opts, scope);
    this.jobs.set(jobId, job);
    return handle;
  }

  status(jobId: string): CrawlJobHandle | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job.handle } : null;
  }

  list(): CrawlJobHandle[] {
    return [...this.jobs.values()].map((j) => ({ ...j.handle }));
  }

  /**
   * Request cancellation. Cooperative: the crawl loop finishes its current
   * page, but the staging directory is discarded and nothing is published.
   */
  cancel(jobId: string): CrawlJobHandle {
    const job = this.jobs.get(jobId);
    if (!job) throw new CrawlJobError("JOB_NOT_FOUND", `no crawl job ${jobId}`);
    if (job.handle.state !== "running") {
      throw new CrawlJobError("JOB_NOT_RUNNING", `crawl job ${jobId} is ${job.handle.state}, not running`);
    }
    job.cancelRequested = true;
    job.handle.state = "cancelled";
    job.handle.finishedAt = new Date().toISOString();
    return { ...job.handle };
  }

  private async run(job: InternalJob, opts: StartCrawlJobOptions, scope: "same-origin" | "same-site" | "any"): Promise<void> {
    const { handle, stagingDir } = job;
    try {
      const graph = new Graph();
      // R4 threading: give the crawl its own session on the configured
      // endpoint. When omitted, the Crawler creates a default session itself.
      let ownSession: BiDiSession | null = null;
      const session = opts.webDriverBase
        ? (ownSession = await BiDiSession.create("firefox", { webDriverBase: opts.webDriverBase }))
        : undefined;
      const crawler = new Crawler(graph, {
        rootUrl: opts.rootUrl,
        budget: { ...handle.budget },
        scope,
        ...(session ? { session } : {}),
      });
      let pagesCrawled = 0;
      // cancel() mutates handle.state from another call stack; route every
      // check through one helper so control flow narrowing can't hide it.
      const cancelled = () => job.cancelRequested || job.handle.state === "cancelled";
      try {
        const result = await crawler.crawl();
        pagesCrawled = result.pages;
      } finally {
        // We own the session we created; the Crawler owns any it created.
        if (ownSession) await ownSession.close().catch(() => undefined);
      }

      if (cancelled()) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        return;
      }

      // Publish atomically: save into staging, then rename into place. The
      // finished directory appears at `outputDir` only once it IS complete.
      const finishedAt = new Date().toISOString();
      const store = new GraphStore(stagingDir);
      await store.save(graph, {
        rootUrl: opts.rootUrl,
        startedAt: handle.startedAt,
        finishedAt,
        browser: { engine: "firefox", version: "154" },
      });
      if (cancelled()) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      await mkdir(dirname(handle.outputDir), { recursive: true });
      await rename(stagingDir, handle.outputDir);

      // Hash the PUBLISHED bytes — after the rename, staging no longer exists.
      const publishedGraphPath = join(handle.outputDir, "graph.json");
      const raw = await readFile(publishedGraphPath, "utf8");
      handle.graphHash = computeGraphHash(raw);
      handle.pages = {
        crawled: pagesCrawled,
        failed: [...graph.pages()].filter((p) => p.loadStatus === "spa-error" || p.loadStatus === "timeout").length,
      };
      handle.state = "complete";
      handle.finishedAt = finishedAt;
    } catch (err) {
      // Nothing partial is ever published: staging is discarded on any failure.
      await rm(job.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (job.handle.state === "cancelled") return;
      handle.state = "failed";
      handle.finishedAt = new Date().toISOString();
      handle.error = err instanceof Error ? err.message : String(err);
    }
  }
}

