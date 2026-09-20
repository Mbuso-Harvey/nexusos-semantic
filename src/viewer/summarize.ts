/**
 * Viewer summary — pure, server-side derivation of the human-readable
 * overview a crawl output directory (GraphStore layout) produces.
 *
 * `summarizeGraph` takes a GraphDocument (what `graph.json` holds) and
 * returns a compact, render-friendly model of the five layers:
 *   - crawl metadata + node-type counts (overview header)
 *   - per-page breakdown (ax/visual/nav/state/capability counts)
 *   - edge-kind histogram
 *   - state-successor adjacency (the Interaction/State graph as a FSM)
 *
 * Everything in this module is a pure function — no filesystem, no HTTP,
 * no browser — so the viewer's data transformation is unit-testable in
 * isolation from the HTTP server and the HTML page.
 *
 * The trace (eval result) is handled separately by `summarizeTrace` so
 * the eval `demo.trace.json` can be rendered in the same page.
 */
import type {
  GraphDocument,
  Edge,
  TransitionTrigger,
  AuthContext,
} from "../graph/types.js";

// ----- Shapes the browser consumes (kept deliberately JSON-safe) -----

/** One page entry in the Pages tab. */
export interface ViewerPageSummary {
  id: string;
  url: string;
  title: string;
  canonicalUrl: string;
  parentPageId: string | null;
  loadStatus: string;
  crawledAt: string;
  axCount: number;
  visualCount: number;
  navElementCount: number;
  stateCount: number;
  capabilityCount: number;
  transitionCount: number;
}

/** One state-successor edge for the States tab (FSM view). */
export interface ViewerStateEdge {
  from: string;
  to: string;
  triggers: TransitionTrigger[];
}

/** One state node for the States tab. */
export interface ViewerStateSummary {
  id: string;
  pageId: string;
  route: string;
  auth: AuthContext;
  firstObservedAt: string;
  evidenceKinds: string[];
  successors: ViewerStateEdge[];
}

/** One edge for the Edges tab. */
export interface ViewerEdgeRow {
  id: string;
  from: string;
  to: string;
  kind: string;
  provenance: string;
  triggers: TransitionTrigger[] | undefined;
}

/** The summarized model the viewer page renders. */
export interface ViewerModel {
  crawl: GraphDocument["crawl"];
  counts: {
    pages: number;
    axNodes: number;
    visualNodes: number;
    navElements: number;
    edges: number;
    capabilities: number;
    transitions: number;
    states: number;
    authContexts: number;
    designTokens: number;
  };
  edgesByKind: Record<string, number>;
  pages: ViewerPageSummary[];
  states: ViewerStateSummary[];
  edges: ViewerEdgeRow[];
}

// ----- Implementation -----

function emptyCounts() {
  return {
    pages: 0,
    axNodes: 0,
    visualNodes: 0,
    navElements: 0,
    edges: 0,
    capabilities: 0,
    transitions: 0,
    states: 0,
    authContexts: 0,
    designTokens: 0,
  };
}

/** Count the design tokens in the nested DTCG tree (leaf = has $value). */
function countTokens(node: Record<string, any>): number {
  let n = 0;
  if (!node || typeof node !== "object") return 0;
  if ("$value" in node && "$type" in node) return 1;
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") n += countTokens(v as Record<string, any>);
  }
  return n;
}

export function summarizeGraph(doc: GraphDocument): ViewerModel {
  const counts = emptyCounts();
  counts.pages = doc.pages.length;
  counts.axNodes = doc.axNodes.length;
  counts.visualNodes = doc.visualNodes.length;
  counts.navElements = doc.navElements?.length ?? 0;
  counts.edges = doc.edges.length;
  counts.capabilities = doc.capabilities.length;
  counts.transitions = doc.transitions.length;
  counts.states = doc.states?.length ?? 0;
  counts.authContexts = doc.authContexts?.length ?? 0;
  counts.designTokens = countTokens(doc.designTokens);

  // Edge kinds histogram (stable, grouped).
  const edgesByKind: Record<string, number> = {};
  for (const e of doc.edges) {
    edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1;
  }

  // Per-page breakdown.
  const pages: ViewerPageSummary[] = doc.pages.map((p) => ({
    id: p.id,
    url: p.url,
    title: p.title,
    canonicalUrl: p.canonicalUrl,
    parentPageId: p.parentPageId,
    loadStatus: p.loadStatus,
    crawledAt: p.crawledAt,
    axCount: doc.axNodes.filter((a) => a.pageId === p.id).length,
    visualCount: doc.visualNodes.filter((v) => v.pageId === p.id).length,
    navElementCount: (doc.navElements ?? []).filter((n) => n.pageId === p.id).length,
    stateCount: (doc.states ?? []).filter((s) => s.pageId === p.id).length,
    capabilityCount: doc.capabilities.filter((c) => c.pageId === p.id).length,
    transitionCount: doc.transitions.filter((t) =>
      doc.axNodes.some((a) => a.id === t.fromAxId && a.pageId === p.id),
    ).length,
  }));

  // State successor edges (FSM).
  const stateEdgesByKind = new Map<string, ViewerStateEdge[]>();
  for (const e of doc.edges) {
    if (e.kind === "state:successor" || e.kind === "state:predecessor") {
      const list = stateEdgesByKind.get(e.kind) ?? [];
      list.push({ from: e.from, to: e.to, triggers: e.triggers ?? [] });
      stateEdgesByKind.set(e.kind, list);
    }
  }
  const successorsOf = (stateId: string): ViewerStateEdge[] =>
    (stateEdgesByKind.get("state:successor") ?? []).filter((e) => e.from === stateId);

  const states: ViewerStateSummary[] = (doc.states ?? []).map((s) => ({
    id: s.id,
    pageId: s.pageId,
    route: s.payload.route ?? "(no route)",
    auth: s.authContext,
    firstObservedAt: s.firstObservedAt,
    evidenceKinds: s.evidence.map((ev) => ev.kind),
    successors: successorsOf(s.id),
  }));

  // Edges tab rows (id, endpoints, kind, provenance, triggers).
  const edges: ViewerEdgeRow[] = doc.edges.map((e: Edge) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    kind: e.kind,
    provenance: e.provenance,
    triggers: e.triggers,
  }));

  return { crawl: doc.crawl, counts, edgesByKind, pages, states, edges };
}