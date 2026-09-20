/**
 * Graph store — plan section 10.
 *
 * v1 keeps it simple: JSON at rest, no OPFS, no SQLite. Rationale (from plan
 * 10.3): a 200-page crawl of typical SaaS apps is < 50 MB, JSON is
 * human-readable for the demo, SQLite is overkill for the prototype.
 *
 * On disk, a crawl produces:
 *   <output-dir>/
 *     graph.json              # full GraphDocument (section 4)
 *     design-tokens.json      # W3C DTCG sidecar (extracted tokens)
 *     crawl.log               # per-page extraction log
 *     crawl.cmeta.json        # {startedAt, rootUrl, frontierHash, pageHashes}
 *
 * `load()` is the inverse: it reads graph.json and rebuilds the in-memory
 * Graph. `save()` is the forward path: it serializes a Graph and writes
 * the full layout to disk.
 *
 * `loadFromDocument(g, doc)` is also exported because the server (Stage 15)
 * can ingest a graph without touching disk (e.g. from a future OPFS shim).
 */
import { writeFile, readFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Graph } from "../graph/graph.js";
import type { GraphDocument, PageNode, SubstrateProvenance } from "../graph/types.js";
import { NEXUS_VERSION } from "../version.js";

export interface CrawlMeta {
  startedAt: string;
  finishedAt: string;
  rootUrl: string;
  browser: { engine: string; version: string };
  pageHashes: Record<string, string>;  // pageId -> sha256 of HTML
  frontierHash: string;                // sha256 of sorted canonical URLs
  /**
   * R5 completeness marker: `false` marks a substrate that was NOT fully
   * produced (interrupted crawl, copied staging dir). `GraphStore.load()`
   * refuses such substrates — a partial graph must fail, never serve.
   * Absent (legacy substrates) is treated as complete.
   */
  complete?: boolean;
}

export class GraphStore {
  constructor(private readonly outputDir: string) {}

  /** Path of the canonical graph.json for this store. */
  get graphPath(): string { return join(this.outputDir, "graph.json"); }
  get metaPath(): string { return join(this.outputDir, "crawl.cmeta.json"); }
  get logPath(): string { return join(this.outputDir, "crawl.log"); }
  get tokensPath(): string { return join(this.outputDir, "design-tokens.json"); }

  /** Append a single log line (caller is responsible for newlines). */
  async appendLog(line: string): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    await appendFile(this.logPath, line.endsWith("\n") ? line : line + "\n", "utf8");
  }

  /**
   * Serialize a Graph to disk in the v1 layout (graph.json + sidecar tokens
   * + meta). Returns the GraphDocument that was written.
   */
  async save(g: Graph, crawlInfo: Omit<GraphDocument["crawl"], "pages" | "tokens">): Promise<GraphDocument> {
    await mkdir(this.outputDir, { recursive: true });
    const doc = g.toDocument({ ...crawlInfo, pages: g.pageCount, tokens: g.tokenCount });

    // Write the graph document
    await writeFile(this.graphPath, JSON.stringify(doc, null, 2), "utf8");

    // Write the DTCG sidecar (just the design tokens subtree, in the format
    // the demo/tasks scripts expect)
    await writeFile(this.tokensPath, JSON.stringify(doc.designTokens, null, 2), "utf8");

    // The meta file is updated incrementally as the crawl progresses; for v1
    // we just write a final snapshot at save() time.
    const meta: CrawlMeta = {
      startedAt: crawlInfo.startedAt,
      finishedAt: crawlInfo.finishedAt,
      rootUrl: crawlInfo.rootUrl,
      browser: { ...crawlInfo.browser },
      pageHashes: {},
      frontierHash: "",
      complete: true,
    };
    await writeFile(this.metaPath, JSON.stringify(meta, null, 2), "utf8");

    return doc;
  }

  /** Load a graph from disk, rebuilding the in-memory Graph instance. */
  async load(): Promise<Graph> {
    const raw = await readFile(this.graphPath, "utf8");
    let doc: GraphDocument;
    try {
      doc = JSON.parse(raw) as GraphDocument;
    } catch (err) {
      throw new SubstrateLoadError(
        "SUBSTRATE_INVALID",
        `graph.json at ${this.graphPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const meta = await this.readMeta();
    // R5 fail-closed completeness gate: a substrate explicitly marked
    // incomplete (interrupted crawl) must never serve. Absent marker =
    // legacy substrate, treated as complete.
    if (meta && meta.complete === false) {
      throw new SubstrateLoadError(
        "SUBSTRATE_INCOMPLETE",
        `substrate at ${this.outputDir} is marked incomplete in crawl.cmeta.json — it was not fully produced (interrupted crawl?). Re-crawl it or remove the marker; refusing to serve a partial graph.`,
      );
    }
    return loadFromDocument(doc, {
      outputDir: this.outputDir,
      graphPath: this.graphPath,
      graphHash: computeGraphHash(raw),
      frontierHash: meta?.frontierHash ?? null,
    });
  }

  /** Whether the graph.json exists in the output dir. */
  async exists(): Promise<boolean> {
    try { await readFile(this.graphPath, "utf8"); return true; }
    catch { return false; }
  }

  /** Read the meta file if present, else return null. */
  async readMeta(): Promise<CrawlMeta | null> {
    try {
      const raw = await readFile(this.metaPath, "utf8");
      return JSON.parse(raw) as CrawlMeta;
    } catch { return null; }
  }
}

/**
 * Reconstruct a Graph from a GraphDocument. Used by the server (Stage 15) to
 * ingest a graph it received over the wire or read from OPFS in a future v2.
 *
 * R2: the document's `crawl` block is no longer discarded — it is restored as
 * substrate provenance so the served graph can prove what it is (rootUrl,
 * crawl timestamps, browser version) alongside the computed content hash.
 */
export function loadFromDocument(
  doc: GraphDocument,
  opts: {
    outputDir?: string | null;
    graphPath?: string | null;
    graphHash?: string | null;
    frontierHash?: string | null;
    buildVersion?: string;
  } = {},
): Graph {
  if (doc.version !== "1.0.0") {
    throw new SubstrateLoadError(
      "SUBSTRATE_INVALID",
      `unsupported graph document version: ${doc.version} (expected "1.0.0"). ` +
        `${opts.graphPath ?? "The document"} is not a Nexus graph.json.`,
    );
  }
  const g = new Graph();
  // Order matters: pages first (ax/visual/capability/nav/edge nodes
  // all reference pageId).
  for (const p of doc.pages) g.upsertPage(p);
  for (const ax of doc.axNodes) g.upsertAx(ax);
  for (const v of doc.visualNodes) g.upsertVisual(v);
  // PR-8a: NavElement round-trip. Older graph.json files (PR-7
  // and earlier) don't have the field; default to [] for forward
  // compat.
  for (const nav of doc.navElements ?? []) g.upsertNavElement(nav);
  for (const e of doc.edges) g.upsertEdge(e);
  for (const c of doc.capabilities) g.upsertCapability(c);
  for (const t of doc.transitions) g.upsertTransition(t);
  // PR-8: state round-trip. Older graph.json files (PR-8a and
  // earlier) don't have the field; default to [] for forward compat.
  for (const s of doc.states ?? []) g.upsertState(s);
  for (const [path, token] of iterateTokens(doc.designTokens, "")) {
    g.upsertToken(path, token);
  }
  if (doc.diagnostics) {
    g.setDiagnostics(doc.diagnostics);
  }

  g.setSubstrateProvenance({
    outputDir: opts.outputDir ?? null,
    graphPath: opts.graphPath ?? null,
    graphHash: opts.graphHash ?? null,
    crawl: doc.crawl ?? null,
    frontierHash: opts.frontierHash ?? null,
    buildVersion: opts.buildVersion ?? NEXUS_VERSION,
  });

  return g;
}

/**
 * Walk the nested design-tokens tree, yielding (dotted-path, DtcgToken) pairs.
 * DTCG supports $value + $type on every leaf; nested groups are plain objects.
 */
function* iterateTokens(node: any, prefix: string): Generator<[string, { $value: any; $type: any; $description?: string; $extensions?: any }]> {
  if (!node || typeof node !== "object") return;
  if ("$value" in node && "$type" in node) {
    yield [prefix, node];
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("$")) continue;  // skip $extensions / $description at group level
    const next = prefix ? `${prefix}.${k}` : k;
    yield* iterateTokens(v, next);
  }
}

/** Compute a stable hash of an array of canonical URLs (for crawl.cmeta.json). */
export function hashFrontier(urls: string[]): string {
  const sorted = [...urls].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/** Compute a stable hash of raw HTML for change detection between crawls. */
export function hashPageContent(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}

/**
 * R2: substrate identity = SHA-256 of the raw graph.json bytes. This is the
 * hash agents assert on (and the one enforcement binds to); it is computed
 * from the file actually loaded, never supplied by the operator.
 */
export function computeGraphHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ---- Fail-closed substrate gate (R1 / §2.4, §6) ------------------------------

export type SubstrateLoadErrorCode =
  | "SUBSTRATE_MISSING"
  | "SUBSTRATE_INVALID"
  | "SUBSTRATE_INCOMPLETE"
  | "SUBSTRATE_HASH_MISMATCH";

/** Thrown when a substrate cannot be loaded or bound — consumers must fail. */
export class SubstrateLoadError extends Error {
  constructor(
    public readonly code: SubstrateLoadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubstrateLoadError";
  }
}

/**
 * Load a substrate directory, failing closed (§6) instead of silently serving
 * an empty graph. This is the gate every serving entry point (CLI `serve`,
 * embedders) must go through: a missing, invalid, or foreign graph.json is a
 * hard error, never `new Graph()`.
 */
export async function loadSubstrate(
  outputDir: string,
): Promise<{ graph: Graph; store: GraphStore; provenance: SubstrateProvenance }> {
  const store = new GraphStore(outputDir);
  if (!(await store.exists())) {
    throw new SubstrateLoadError(
      "SUBSTRATE_MISSING",
      `no substrate at ${outputDir} — ${store.graphPath} not found. Produce one first: ` +
        `\`nexus crawl <url> --out ${outputDir}\`, or point --graph at an existing substrate directory.`,
    );
  }
  let graph: Graph;
  try {
    graph = await store.load();
  } catch (err) {
    if (err instanceof SubstrateLoadError) throw err;
    throw new SubstrateLoadError(
      "SUBSTRATE_INVALID",
      `graph.json at ${store.graphPath} could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const provenance = graph.substrateProvenance;
  if (!provenance) {
    throw new SubstrateLoadError(
      "SUBSTRATE_INVALID",
      `graph.json at ${store.graphPath} loaded without substrate provenance — refusing to serve an unattributed substrate.`,
    );
  }
  return { graph, store, provenance };
}

/**
 * R2: bind the enforcement manifest to the substrate actually loaded.
 *
 * `expected` is the operator-asserted hash (`AWG_GRAPH_HASH` / `--graph-hash`).
 * When set, it must match the computed hash of the loaded graph.json, or the
 * process refuses to start: an authorization binds to a graph revision, and
 * serving a different one than authorized is a silent substitution (§2.4).
 * Accepts the optional `sha256:` prefix form.
 */
export function assertGraphHashBinding(
  provenance: SubstrateProvenance | null,
  expected: string | null | undefined,
): void {
  if (!expected) return;
  const want = expected.replace(/^sha256:/, "").trim().toLowerCase();
  const have = provenance?.graphHash
    ? provenance.graphHash.replace(/^sha256:/, "").trim().toLowerCase()
    : null;
  if (!have) {
    throw new SubstrateLoadError(
      "SUBSTRATE_HASH_MISMATCH",
      `a graph hash is asserted (${expected}) but the loaded substrate has no computed hash ` +
        `(in-memory graph?). Refusing to serve — serve a real substrate directory, or unset AWG_GRAPH_HASH.`,
    );
  }
  if (have !== want) {
    throw new SubstrateLoadError(
      "SUBSTRATE_HASH_MISMATCH",
      `graph hash mismatch: expected ${want}, loaded substrate is ${have}. The authorization binds to a ` +
        `graph revision that is not what was loaded. Refusing to serve — re-crawl, or update AWG_GRAPH_HASH / --graph-hash.`,
    );
  }
}
