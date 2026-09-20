/**
 * R5 crawl job manager — async substrate production with atomic publish.
 *
 * Gate tests per §6: each assertion fails without the R5 implementation.
 * Runs entirely against mock BiDi sessions (no geckodriver required).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CrawlJobManager, CrawlJobError } from "../../src/crawler/jobs.js";
import { GraphStore } from "../../src/store/store.js";

function makeMockPage(overrides: Partial<{ url: string; outLinks: string[]; delayMs: number }> = {}) {
  const outLinks = overrides.outLinks ?? [];
  const delayMs = overrides.delayMs ?? 0;
  const evaluate = async (_t: any, src: string) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (src.includes("querySelector('h1")) return "Hello";
    if (src.includes("querySelectorAll('[role]")) return 5;
    if (src.includes("getBoundingClientRect")) return [];
    if (src.includes("popovertarget")) return [];
    if (src.includes("querySelectorAll('a[href]")) return outLinks;
    if (src.includes("querySelectorAll('button, a, [role=button]")) return 0;
    if (src.includes("querySelectorAll('*'))")) return 0;
    return null;
  };
  return {
    url: Promise.resolve(overrides.url ?? "https://example.com/"),
    title: Promise.resolve("T"),
    target: { context: "ctx" } as any,
    navigate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    script: {
      evaluate,
      callFunction: vi.fn(async (_t: any, _fn: string, _args: any[]) =>
        outLinks.map((href) => ({
          fromAxId: `ax:page:href:${href}`,
          toAxId: `ax:page:href:${href}`,
          kind: "link",
          href,
          rawHref: href,
          isExternal: false,
          isAnchor: false,
          isJs: false,
        })),
      ),
    },
  } as any;
}

function makeMockSession(pages: any[]) {
  return {
    newPage: vi.fn(async () => pages.shift() ?? makeMockPage()),
    close: vi.fn(async () => undefined),
  } as any;
}

/** Patch the module's BiDiSession so jobs that create their own session get mocks. */
vi.mock("../../src/bidi-client/session.js", () => ({
  BiDiSession: { create: vi.fn(async () => makeMockSession([makeMockPage()])) },
}));

async function waitForTerminal(handle: { jobId: string }, mgr: CrawlJobManager, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = mgr.status(handle.jobId)!;
    if (h.state !== "running") return h;
    if (Date.now() > deadline) throw new Error(`job ${handle.jobId} still running after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("CrawlJobManager (R5)", () => {
  it("completes a crawl and publishes a complete substrate with a computed graphHash", async () => {
    const mgr = new CrawlJobManager();
    const outDir = join(mkdtempSync(join(tmpdir(), "awg-jobs-")), "sub");
    const handle = mgr.start({
      rootUrl: "https://example.com/",
      outputDir: outDir,
      producer: { actorId: "test-agent", authorizationId: "auth-1", mode: "delegated" },
    });
    expect(handle.state).toBe("running");
    expect(handle.jobId).toMatch(/^crawl-/);
    expect(handle.producer).toEqual({ actorId: "test-agent", authorizationId: "auth-1", mode: "delegated" });
    expect(handle.graphHash).toBeNull();

    const done = await waitForTerminal(handle, mgr);
    expect(done.state).toBe("complete");
    expect(done.error).toBeNull();
    // computed from the published graph.json bytes, not operator-supplied
    expect(done.graphHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.pages.crawled).toBeGreaterThan(0);

    // The published dir is the ONLY handle serve needs, and it is complete.
    expect(existsSync(join(outDir, "graph.json"))).toBe(true);
    const cmeta = JSON.parse(readFileSync(join(outDir, "crawl.cmeta.json"), "utf8"));
    expect(cmeta.complete).toBe(true);
    expect(cmeta.rootUrl).toBe("https://example.com/");

    // The hash on the handle matches the published bytes.
    const { computeGraphHash } = await import("../../src/store/store.js");
    expect(done.graphHash).toBe(computeGraphHash(readFileSync(join(outDir, "graph.json"), "utf8")));

    // The staging dir is gone — nothing partial lingers.
    expect(existsSync(`${outDir}.partial-${handle.jobId}`)).toBe(false);
  });

  it("refuses to overwrite an existing substrate (producing is explicit)", async () => {
    const mgr = new CrawlJobManager();
    const outDir = join(mkdtempSync(join(tmpdir(), "awg-jobs-")), "sub");
    const first = mgr.start({
      rootUrl: "https://example.com/",
      outputDir: outDir,
      producer: { actorId: "a", authorizationId: null, mode: "delegated" },
    });
    await waitForTerminal(first, mgr);

    expect(() =>
      mgr.start({
        rootUrl: "https://other.example.com/",
        outputDir: outDir,
        producer: { actorId: "a", authorizationId: null, mode: "delegated" },
      }),
    ).toThrowError(/SUBSTRATE_EXISTS|already exists/i);
  });

  it("converges duplicate requests on the running job (idempotency key)", async () => {
    const mgr = new CrawlJobManager();
    const outDir = join(mkdtempSync(join(tmpdir(), "awg-jobs-")), "sub");
    // A slow page keeps the job running long enough for the second start().
    const slowSession = {
      newPage: vi.fn(async () => makeMockPage({ delayMs: 120 })),
      close: vi.fn(async () => undefined),
    } as any;
    const { BiDiSession } = await import("../../src/bidi-client/session.js");
    vi.mocked(BiDiSession.create).mockResolvedValueOnce(slowSession as any);
    const first = mgr.start({
      rootUrl: "https://example.com/",
      outputDir: outDir,
      producer: { actorId: "a", authorizationId: null, mode: "delegated" },
    });
    // Second identical request while the first is running → same job.
    const second = mgr.start({
      rootUrl: "https://example.com/",
      outputDir: outDir,
      producer: { actorId: "a", authorizationId: null, mode: "delegated" },
    });
    expect(second.jobId).toBe(first.jobId);
    await waitForTerminal(first, mgr);
  });

  it("cancel discards staging and publishes nothing", async () => {
    const mgr = new CrawlJobManager();
    const outDir = join(mkdtempSync(join(tmpdir(), "awg-jobs-")), "sub");
    const handle = mgr.start({
      rootUrl: "https://example.com/",
      outputDir: outDir,
      producer: { actorId: "a", authorizationId: null, mode: "delegated" },
    });
    mgr.cancel(handle.jobId);
    const done = await waitForTerminal(handle, mgr);
    expect(done.state).toBe("cancelled");
    expect(done.graphHash).toBeNull();
    // Wait for the background run to finish cleaning up.
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(`${outDir}.partial-${handle.jobId}`)).toBe(false);
    expect(() => mgr.cancel(handle.jobId)).toThrowError(CrawlJobError);
  });

  it("session-creation failure produces a failed job and no substrate", async () => {
    const mgr = new CrawlJobManager();
    const outDir = join(mkdtempSync(join(tmpdir(), "awg-jobs-")), "sub");
    const { BiDiSession } = await import("../../src/bidi-client/session.js");
    vi.mocked(BiDiSession.create).mockRejectedValueOnce(new Error("boom: geckodriver exploded"));
    const handle = mgr.start({
      rootUrl: "https://example.com/",
      outputDir: outDir,
      producer: { actorId: "a", authorizationId: null, mode: "delegated" },
    });
    const done = await waitForTerminal(handle, mgr);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("boom");
    expect(done.graphHash).toBeNull();
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(`${outDir}.partial-${handle.jobId}`)).toBe(false);
  });

  it("GraphStore.load refuses a substrate marked incomplete (SUBSTRATE_INCOMPLETE)", async () => {
    const base = mkdtempSync(join(tmpdir(), "awg-jobs-"));
    const dir = join(base, "sub");
    const { Graph } = await import("../../src/graph/graph.js");
    const g = new Graph();
    g.upsertPage({
      id: "page:/", type: "page", url: "https://example.com/", title: "Example",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
      canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
    });
    const store = new GraphStore(dir);
    await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      browser: { engine: "firefox", version: "154" },
    });
    // Complete substrate loads fine.
    await expect(store.load()).resolves.toBeInstanceOf(Graph);
    // Mark it incomplete → load must hard-fail, never serve a partial graph.
    const metaPath = join(dir, "crawl.cmeta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.complete = false;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    await expect(store.load()).rejects.toThrowError(/SUBSTRATE_INCOMPLETE|incomplete/i);
    rmSync(base, { recursive: true, force: true });
  });
});

