/**
 * extract-discovery/nav-links — PR-8a T2: resolved page-to-page
 * navigation-link edges.
 *
 * The discovery extractor writes per-link axId-level "link" edges
 * (e.g. `edge:<ax>-><ax>:link`). The Layer 1 navigation graph also
 * wants the resolved page-to-page relationship ("there exists a
 * link on page A that leads to page B"). This helper walks the
 * graph's "link" edges from a given page and emits one
 * `nav-link` edge per (source page, target page) pair whose
 * target is also in the graph.
 *
 * Per the plan:
 *  - External and same-page anchor links do not produce nav-link
 *    edges (they don't navigate to another page in the graph).
 *  - Edge id is deterministic: `edge:<fromPageId>-><toPageId>:nav-link`.
 *  - Idempotent: upsertEdge overwrites; the second call is a no-op
 *    structurally.
 *
 * Pure function: takes the Graph + a source page id, returns the
 * list of nav-link edges to upsert. Exported so unit tests can
 * drive it without a BiDi session.
 */
import type { Graph } from "../graph/graph.js";
import type { Edge } from "../graph/types.js";

/**
 * Walk the graph's "link" edges from the given page and resolve them
 * to a list of `nav-link` page-to-page edges. A link is resolved iff:
 *  - the source axId is on the source page (axId starts with
 *    `ax:<sourcePageId>:`)
 *  - the destination axId encodes a same-origin URL (we strip
 *    `ax:<pageId>:href:<href>` to get the href, then canonicalize)
 *  - the canonicalized URL corresponds to a known PageNode in the
 *    graph (the page has already been crawled)
 *  - the destination is a different page (no self-loops)
 *
 * External/anchor/javascript links are excluded because they don't
 * point to another known page.
 *
 * Iterates over the graph's edge-by-from index directly so the
 * resolver does not require the link's source axId to be present in
 * the axNode table (the discovery extractor writes link edges whose
 * source axIds are synthetic and may not have been upserted).
 */
export function buildNavLinkEdges(g: Graph, sourcePageId: string): Edge[] {
  const sourcePage = g.getPage(sourcePageId);
  if (!sourcePage) return [];

  // Build a map of canonicalUrl -> pageId for the lookup.
  const byUrl = new Map<string, string>();
  for (const p of g.pages()) {
    if (p.id !== sourcePageId) byUrl.set(p.canonicalUrl, p.id);
  }

  const out: Edge[] = [];
  const seen = new Set<string>(); // dedupe (from, to) pairs
  const sourceAxPrefix = `ax:${sourcePageId}:`;

  for (const e of g.allEdges()) {
    if (e.kind !== "link") continue;
    // The link edge's source must be an axId on the source page.
    if (!e.from.startsWith(sourceAxPrefix)) continue;
    // The destination axId encodes the pageId in the middle. PageIds
    // are `page:<canonicalUrl>` and URLs contain colons (scheme
    // separator and optional port). The href/external/js segment is
    // always the LAST colon-segment, so anchor on `:href:` /
    // `:external:` / `:js:` at the end of the id.
    const m = e.to.match(/^ax:.+:(href|external|js):(.+)$/);
    if (!m) continue;
    const klass = m[1];
    const rawHref = m[2]!;
    if (klass === "external" || klass === "js") continue;
    if (!rawHref) continue;
    if (rawHref.startsWith("#")) continue; // anchor
    if (rawHref.startsWith("javascript:")) continue;

    // Resolve the href against the source page's URL. We use a
    // best-effort synchronous resolver: if `new URL` fails, skip.
    let resolved: string;
    try {
      resolved = new URL(rawHref, sourcePage.url).href;
    } catch {
      continue;
    }
    // Apply the same canonicalization the Crawler uses for dedup.
    const canon = canonicalizeUrl(resolved);
    const targetPageId = byUrl.get(canon);
    if (!targetPageId) continue;
    if (targetPageId === sourcePageId) continue; // self-loop

    const pairKey = `${sourcePageId}->${targetPageId}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    out.push({
      id: `edge:${sourcePageId}->${targetPageId}:nav-link`,
      type: "edge",
      from: sourcePageId,
      to: targetPageId,
      kind: "nav-link",
      provenance: "html:hierarchy",
    });
  }
  return out;
}

/**
 * Lightweight canonicalization used by the nav-link resolver. Mirrors
 * Crawler.canonicalize but is exported here so unit tests can call it
 * without pulling the orchestrator's full session machinery.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    const params = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of params) u.searchParams.append(k, v);
    return u.href;
  } catch {
    return url;
  }
}
