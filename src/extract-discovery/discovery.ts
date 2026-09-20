/**
 * Discovery extractor (Stage 9) — walks every outbound link on the page and
 * emits the appropriate edges into the graph. Also returns the list of
 * same-origin URLs so the orchestrator can extend its BFS frontier.
 *
 * Plan reference: sections 4.6 (edges) and 6.4 (crawl BFS).
 *
 * The extractor runs a single `script.callFunction` in the page that walks
 * `document.querySelectorAll('a[href], area[href], [role=link]')` and emits
 * a JSON array of normalized link records. The Node side then classifies
 * each record (same-origin / same-page anchor / external / javascript:),
 * writes edges, and hands the same-origin URLs back to the orchestrator
 * through the return value of `run()`.
 */
import type { Extractor, ExtractorContext } from "../crawler/orchestrator.js";
import type { Edge, PageNode } from "../graph/types.js";

// ----- Page-side record shape -----
// One record per matched link element. All fields are JSON-safe so the
// BiDi serializer can transport them without handles.
export interface DiscoveryLinkRecord {
  /** axId of the link element itself (the source of the link edge). */
  fromAxId: string;
  /** Synthetic destination axId: `ax:<pageId>:href:<href>`. */
  toAxId: string;
  /** Always "link" for now; reserved for future edge kinds. */
  kind: "link";
  /** Resolved absolute URL. Empty string when the href is unparseable. */
  href: string;
  /** Raw href attribute (preserved for provenance / debug). */
  rawHref: string;
  /** True when the link points to a different origin than the current page. */
  isExternal: boolean;
  /** True when the link is a same-page anchor (href starts with "#"). */
  isAnchor: boolean;
  /** True when the href is a javascript: URL. */
  isJs: boolean;
}

// ----- Extractor-side result -----
export interface DiscoveryRunResult {
  produced: boolean;
  durationMs: number;
  /** Same-origin URLs the orchestrator should enqueue (raw, not canonicalized). */
  sameOriginUrls: string[];
}

// ----- Helper: classify a parsed link record -----
export type LinkClass =
  | "same-origin"
  | "anchor"
  | "external"
  | "javascript"
  | "unparseable";

export function classifyLink(record: DiscoveryLinkRecord): LinkClass {
  if (record.isJs) return "javascript";
  if (record.isAnchor) return "anchor";
  if (record.isExternal) return "external";
  if (!record.href) return "unparseable";
  return "same-origin";
}

// ----- Helper: build the edge for a classified link -----
export function buildEdge(
  pageNode: PageNode,
  record: DiscoveryLinkRecord,
  klass: LinkClass,
): Edge | null {
  // Anchors, externals, and javascript: URLs still get a "link" edge so the
  // graph knows they exist; only the provenance differs and the orchestrator
  // decides what to follow.
  const provenance =
    klass === "anchor" ? "html:anchor" : "html:href";
  // External / javascript targets are still link edges, but the destination
  // axId encodes the classification so the edge id stays unique per href.
  let toAxId = record.toAxId;
  if (klass === "external") {
    toAxId = `ax:${pageNode.id}:external:${record.rawHref}`;
  } else if (klass === "javascript") {
    toAxId = `ax:${pageNode.id}:js:${record.rawHref}`;
  }
  const id = `edge:${record.fromAxId}->${toAxId}:link`;
  return {
    id,
    type: "edge",
    from: record.fromAxId,
    to: toAxId,
    kind: "link",
    provenance,
  };
}

// ----- The page-side walker -----
// Runs entirely in the page realm. We pass `pageId` as the only argument
// (BiDi-serialized) so the walker doesn't have to know how to fetch the
// page id out of the orchestrator context.
const DISCOVERY_FN = `(pageId) => {
  const out = [];
  const sel = 'a[href], area[href], [role=link]';
  const nodes = document.querySelectorAll(sel);
  for (const el of nodes) {
    // Skip elements that are not actual links.
    const tag = el.tagName;
    const isExplicitAnchor = tag === 'A' || tag === 'AREA';
    const isRoleLink = el.getAttribute('role') === 'link';
    if (!isExplicitAnchor && !isRoleLink) continue;

    // For [role=link] without an href, nothing to walk.
    if (!isExplicitAnchor && !el.hasAttribute('href')) continue;

    const rawHref = el.getAttribute('href') || '';
    if (!rawHref) continue;

    // fromAxId: prefer element id, fall back to href-based synthetic id.
    const fromAxId = el.id
      ? 'ax:' + pageId + ':' + el.id
      : 'ax:' + pageId + ':href:' + rawHref;

    // Classification in the page realm keeps the wire payload small.
    let resolved = '';
    let isAnchor = false;
    let isJs = false;
    let isExternal = false;
    if (rawHref.startsWith('#')) {
      isAnchor = true;
      resolved = rawHref;
    } else if (rawHref.slice(0, 11).toLowerCase() === 'javascript:') {
      isJs = true;
      resolved = '';
    } else {
      try {
        const u = new URL(rawHref, location.href);
        resolved = u.href;
        isExternal = u.origin !== location.origin;
      } catch {
        resolved = '';
      }
    }

    out.push({
      fromAxId,
      toAxId: 'ax:' + pageId + ':href:' + rawHref,
      kind: 'link',
      href: resolved,
      rawHref,
      isExternal,
      isAnchor,
      isJs,
    });
  }
  return out;
}`;

/**
 * DiscoveryExtractor — the Stage 9 extractor. Walks every outbound link,
 * writes "link" edges, and returns the same-origin URLs for the orchestrator
 * to enqueue.
 */
export class DiscoveryExtractor {
  readonly name = "discovery";

  /** Pure helper exposed for unit tests. */
  process(
    pageNode: PageNode,
    records: DiscoveryLinkRecord[],
  ): { edges: Edge[]; sameOriginUrls: string[] } {
    const edges: Edge[] = [];
    const sameOriginUrls: string[] = [];
    for (const r of records) {
      const klass = classifyLink(r);
      const edge = buildEdge(pageNode, r, klass);
      if (edge) edges.push(edge);
      if (klass === "same-origin" && r.href) {
        sameOriginUrls.push(r.href);
      }
    }
    return { edges, sameOriginUrls };
  }

  /** Extractor entry point. */
  async run(ctx: ExtractorContext): Promise<DiscoveryRunResult> {
    const t0 = Date.now();
    const { graph, page, pageNode, log } = ctx;
    const records = await page.script.callFunction<DiscoveryLinkRecord[]>(
      page.target,
      DISCOVERY_FN,
      [pageNode.id],
    );
    const { edges, sameOriginUrls } = this.process(pageNode, records ?? []);
    let produced = false;
    for (const e of edges) {
      graph.upsertEdge(e);
      produced = true;
    }
    log(`  [discovery] outbound-links=${records?.length ?? 0} same-origin=${sameOriginUrls.length}`);
    return { produced, durationMs: Date.now() - t0, sameOriginUrls };
  }
}

/** Default singleton matching the orchestrator's `Extractor` interface. */
export const discoveryExtractor: Extractor = new DiscoveryExtractor();
