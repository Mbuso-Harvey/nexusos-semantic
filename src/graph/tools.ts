/**
 * graph.path / graph.tool / graph.act / graph.explain — the four MCP-shaped
 * tools the agent uses to navigate the graph. Plan section 9.1.
 *
 *   graph.path  — find a path between two ax nodes
 *   graph.tool  — list the webmcp-style capabilities on a page (filtered)
 *   graph.act   — invoke a capability, with security-tier enforcement
 *   graph.explain — return the chain of edges from an ax node to its surroundings
 *
 * These all operate on the in-memory `Graph`; the BiDi-backed action layer
 * (Stage 15) wraps `act` with browser transport.
 */
import type { Graph } from "./graph.js";
import type {
  AxNode, Edge, EdgeKind, Capability, PageNode, NavElement, StateNode,
} from "./types.js";
import { decide, type ActDecision, type SecurityTier } from "./security.js";

// ---------- graph.path ----------

export interface PathStep {
  from: string;        // axId
  to: string;          // axId
  via: EdgeKind;       // edge.kind
  provenance: string;
}

export interface PathResult {
  found: boolean;
  hops: PathStep[];
  cost: number;        // hop count
}

export function findPath(
  g: Graph,
  fromAxId: string,
  toAxId: string,
  opts: { via?: EdgeKind[]; maxHops?: number } = {},
): PathResult {
  if (!g.getAx(fromAxId) || !g.getAx(toAxId)) {
    return { found: false, hops: [], cost: -1 };
  }
  if (fromAxId === toAxId) {
    return { found: true, hops: [], cost: 0 };
  }
  const maxHops = opts.maxHops ?? 5;
  const allowedKinds = opts.via && opts.via.length > 0 ? new Set(opts.via) : null;

  // BFS over the edge index, tracking parents to reconstruct the path.
  const visited = new Set<string>([fromAxId]);
  const parent = new Map<string, { prev: string; edge: Edge }>();
  const frontier: Array<{ id: string; hops: number }> = [{ id: fromAxId, hops: 0 }];

  while (frontier.length) {
    const { id, hops } = frontier.shift()!;
    if (hops >= maxHops) continue;
    for (const e of g.edgesFrom(id)) {
      if (allowedKinds && !allowedKinds.has(e.kind)) continue;
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      parent.set(e.to, { prev: id, edge: e });
      if (e.to === toAxId) {
        return reconstruct(parent, fromAxId, toAxId);
      }
      frontier.push({ id: e.to, hops: hops + 1 });
    }
  }
  return { found: false, hops: [], cost: -1 };
}

function reconstruct(
  parent: Map<string, { prev: string; edge: Edge }>,
  from: string,
  to: string,
): PathResult {
  const steps: PathStep[] = [];
  let cursor = to;
  while (cursor !== from) {
    const p = parent.get(cursor);
    if (!p) return { found: false, hops: [], cost: -1 };
    steps.unshift({ from: p.prev, to: cursor, via: p.edge.kind, provenance: p.edge.provenance });
    cursor = p.prev;
  }
  return { found: true, hops: steps, cost: steps.length };
}

// ---------- graph.path as a traversal surface (PR-6 / ED-04, PR-7 / ED-03) ----------
//
// `findPath` keeps its existing shortest-path semantics for backward
// compatibility. `relate` is the general surface that the MCP
// `graph.path` tool dispatches to when the caller passes a `relation` arg.
//
// Supported relations (per ED-04 + user surface decision 2026-08-30;
// extended for page-level relations in PR-7 / ED-03):
//   children    — immediate children (parent -> child) via the relation's
//                 edge kind. ax-node uses a11y:child-of; page uses
//                 nav:child-of.
//   parent      — the single parent (via the relation's edge kind in
//                 reverse). Same edge kinds as children.
//   descendants — all descendants up to `depth` hops (default 5, max 20).
//   ancestors   — all ancestors up to `depth` hops (default 5, max 20).
//   path        — shortest path BFS (ax-node target uses findPath; page
//                 target uses a parallel implementation over the page
//                 edge index).
//
// The `target` field chooses which node kind the traversal operates on.
// Default is "ax-node" (the PR-6 behavior); "page" is PR-7 and walks
// the navigation hierarchy using nav:child-of edges + PageNode.parentPageId.

export type TraversalRelation =
  | "children"
  | "parent"
  | "descendants"
  | "ancestors"
  | "path"
  // PR-8a: page-level relations that operate on the Layer 1
  // navigation structure (page-to-page links, breadcrumb trails,
  // menu/menubar/tablist NavElements, per-tab container). These
  // live on the same surface (graph.path) per the user surface
  // decision.
  | "nav-links"
  | "breadcrumbs"
  | "menu"
  | "tab-of"
  // PR-8: state-level relations. The Interaction/State Graph is a
  // directed reachability graph (per ED-01 req #6), not a tree, so
  // the tree-style relations (children/parent/descendants/ancestors)
  // are NOT exposed for the state target — only successors,
  // predecessors, reachable, and path.
  | "successors"
  | "predecessors"
  | "reachable";

export type TraversalTarget = "ax-node" | "page" | "state";

export interface TraversalOptions {
  depth?: number;       // for descendants/ancestors (default 5, max 20)
  via?: EdgeKind[];     // for path only
  maxHops?: number;     // for path only
  to?: string;          // for path only
}

export interface TraversalResult {
  relation: TraversalRelation;
  from: string;
  target?: TraversalTarget;
  // For "path" the response carries the same shape as PathResult.
  // For the enumeration relations we return the visited nodes in BFS
  // order (for descendants/ancestors) or in edge-from order (for
  // children). `hops` is only set when relation === "path".
  // PR-8a: NavElement is part of the return shape for the new
  // "menu" and "tab-of" relations (and as the source of "breadcrumbs").
  // PR-8: StateNode is part of the return shape for state-target
  // relations (successors/predecessors/reachable/path).
  nodes?: Array<AxNode | PageNode | NavElement | StateNode>;
  parent?: AxNode | PageNode | NavElement | StateNode | null;
  found?: boolean;
  hops?: PathStep[];
  cost?: number;
}

const DEFAULT_DEPTH = 5;
const MAX_DEPTH = 20;

export function relate(
  g: Graph,
  fromId: string,
  relation: TraversalRelation,
  opts: TraversalOptions = {},
): TraversalResult {
  // PR-8a: the four new relations (`nav-links`, `breadcrumbs`,
  // `menu`, `tab-of`) are page-level Layer 1 relations. They live
  // on the page dispatch even though the `from` for three of them
  // is an axId (the container, member, or tab axId). Route them
  // through relatePage directly so inferTarget's id-prefix routing
  // doesn't matter.
  if (NAV_LEVEL_RELATIONS.has(relation)) {
    return relatePage(g, fromId, relation, opts);
  }
  // PR-8: state-level relations go through relateState. State ids
  // are `state:<sha256>`-prefixed and the State graph is a directed
  // reachability graph (no children/parent/descendants/ancestors).
  if (STATE_LEVEL_RELATIONS.has(relation) || fromId.startsWith("state:")) {
    return relateState(g, fromId, relation, opts);
  }
  // Dispatch: the page target is a separate branch because it walks
  // nav:child-of edges over PageNodes, not AxNodes. The default ("ax-node")
  // is the PR-6 behavior.
  const target: TraversalTarget = inferTarget(fromId, relation);
  if (target === "page") {
    return relatePage(g, fromId, relation, opts);
  }
  return relateAx(g, fromId, relation, opts);
}

const NAV_LEVEL_RELATIONS: ReadonlySet<TraversalRelation> = new Set<TraversalRelation>([
  "nav-links",
  "breadcrumbs",
  "menu",
  "tab-of",
]);

/**
 * State-only relations. `path` is intentionally NOT here: `path`
 * is shared across ax-node / page / state targets, and dispatch
 * is by the id's prefix. Adding `path` here would steal page-level
 * `path` calls (where `from` is `page:/b` and the test asserts
 * `r.target === "page"`).
 */
const STATE_LEVEL_RELATIONS: ReadonlySet<TraversalRelation> = new Set<TraversalRelation>([
  "successors",
  "predecessors",
  "reachable",
]);

/**
 * PR-8: the relations that are tree-style are NOT supported for
 * the state target. The Interaction/State Graph is a directed
 * reachability graph, not a tree (per ED-01 req #6). When the
 * state target receives one of these, the call returns an empty
 * result with a clear `relation` echo — the MCP tool surfaces
 * this as `isError: true`.
 */
const STATE_DISALLOWED_RELATIONS: ReadonlySet<TraversalRelation> = new Set<TraversalRelation>([
  "children",
  "parent",
  "descendants",
  "ancestors",
]);

/**
 * Pick the traversal target from the id's prefix. Page ids are
 * `page:<canonical-url>`; ax-node ids are `ax:...`; state ids are
 * `state:<sha256-hex>`. The relation argument is a hint: `path` is
 * ax-only when called via this overload (page-level shortest path
 * uses the page dispatch below; state-level shortest path uses
 * relateState).
 */
function inferTarget(id: string, _relation: TraversalRelation): TraversalTarget {
  if (id.startsWith("page:")) return "page";
  if (id.startsWith("state:")) return "state";
  return "ax-node";
}

function relateAx(
  g: Graph,
  fromAxId: string,
  relation: TraversalRelation,
  opts: TraversalOptions,
): TraversalResult {
  // path: delegate to findPath; preserve its result shape.
  if (relation === "path") {
    const to = opts.to;
    if (!to) {
      return { relation, from: fromAxId, target: "ax-node", found: false, hops: [], cost: -1 };
    }
    const r = findPath(g, fromAxId, to, {
      via: opts.via,
      maxHops: opts.maxHops,
    });
    return { relation, from: fromAxId, target: "ax-node", ...r };
  }

  // All other relations require the start node to exist.
  if (!g.getAx(fromAxId)) {
    return { relation, from: fromAxId, target: "ax-node", nodes: [] };
  }

  switch (relation) {
    case "children": {
      // Immediate children: outgoing a11y:child-of edges (parent -> child).
      const childEdges = g.edgesFrom(fromAxId, "a11y:child-of");
      const out: AxNode[] = [];
      for (const e of childEdges) {
        const n = g.getAx(e.to);
        if (n) out.push(n);
      }
      return { relation, from: fromAxId, target: "ax-node", nodes: out };
    }
    case "parent": {
      // The single parent: incoming a11y:child-of edges (parent -> child).
      const parentEdges = g.edgesTo(fromAxId, "a11y:child-of");
      const p = parentEdges.length > 0 ? g.getAx(parentEdges[0]!.from) ?? null : null;
      return { relation, from: fromAxId, target: "ax-node", parent: p };
    }
    case "descendants": {
      const depth = clampDepth(opts.depth);
      const out: AxNode[] = [];
      const visited = new Set<string>([fromAxId]);
      let frontier: Array<{ id: string; hops: number }> = [{ id: fromAxId, hops: 0 }];
      while (frontier.length) {
        const next: typeof frontier = [];
        for (const { id, hops } of frontier) {
          if (hops >= depth) continue;
          for (const e of g.edgesFrom(id, "a11y:child-of")) {
            if (visited.has(e.to)) continue;
            visited.add(e.to);
            const n = g.getAx(e.to);
            if (n) out.push(n);
            next.push({ id: e.to, hops: hops + 1 });
          }
        }
        frontier = next;
      }
      return { relation, from: fromAxId, target: "ax-node", nodes: out };
    }
    case "ancestors": {
      const depth = clampDepth(opts.depth);
      const out: AxNode[] = [];
      const visited = new Set<string>([fromAxId]);
      let frontier: Array<{ id: string; hops: number }> = [{ id: fromAxId, hops: 0 }];
      while (frontier.length) {
        const next: typeof frontier = [];
        for (const { id, hops } of frontier) {
          if (hops >= depth) continue;
          for (const e of g.edgesTo(id, "a11y:child-of")) {
            if (visited.has(e.from)) continue;
            visited.add(e.from);
            const n = g.getAx(e.from);
            if (n) out.push(n);
            next.push({ id: e.from, hops: hops + 1 });
          }
        }
        frontier = next;
      }
      return { relation, from: fromAxId, target: "ax-node", nodes: out };
    }
    default: {
      // PR-8a: the four nav-level relations (`nav-links`,
      // `breadcrumbs`, `menu`, `tab-of`) are dispatched through
      // relatePage by `relate()` before reaching here. This branch
      // exists only to satisfy the type system for any future
      // relation values added to TraversalRelation that don't apply
      // to ax-nodes.
      return { relation, from: fromAxId, target: "ax-node", nodes: [] };
    }
  }
}

/**
 * Page-level traversal. Walks nav:child-of edges (parent -> child) and
 * mirrors the ax-node dispatch, but reads/writes PageNodes instead of
 * AxNodes. The `path` relation is a parallel BFS over the same edge
 * kind — not a delegate to findPath (which is ax-node-scoped).
 *
 * PR-8a: extends with four page-level Layer 1 relations:
 *  - "nav-links"  — pages reachable from `from` via `nav-link` edges
 *                   (immediate neighbors, not transitive).
 *  - "breadcrumbs" — the ordered breadcrumb items on `from` (the page
 *                   must have at least one breadcrumb NavElement; we
 *                   return the items in trail order, not as a tree).
 *  - "menu"       — for a container axId (or a page), the menu /
 *                   menubar / tablist NavElements whose `containerAxId`
 *                   matches, plus their `memberAxIds`.
 *  - "tab-of"     — for a tab axId, the tablist NavElement that
 *                   contains it (inverse of `menu` for tablists).
 */
function relatePage(
  g: Graph,
  fromId: string,
  relation: TraversalRelation,
  opts: TraversalOptions,
): TraversalResult {
  if (relation === "path") {
    const to = opts.to;
    if (!to) {
      return { relation, from: fromId, target: "page", found: false, hops: [], cost: -1 };
    }
    const r = findPagePath(g, fromId, to, {
      maxHops: opts.maxHops ?? 5,
    });
    return { relation, from: fromId, target: "page", ...r };
  }

  // PR-8a: nav-level relations. The dispatch is by `from` shape:
  //  - `page:<url>` for nav-links (page-to-page)
  //  - `ax:<pageId>:...` for breadcrumbs (when the from is a
  //    breadcrumb container's axId) and for menu / tab-of
  //    (when the from is the container / member axId)
  if (relation === "nav-links") {
    if (!g.getPage(fromId)) {
      return { relation, from: fromId, target: "page", nodes: [] };
    }
    const navEdges = g.edgesFrom(fromId, "nav-link");
    const out: PageNode[] = [];
    for (const e of navEdges) {
      const p = g.getPage(e.to);
      if (p) out.push(p);
    }
    return { relation, from: fromId, target: "page", nodes: out };
  }

  if (relation === "breadcrumbs") {
    // The from here is the breadcrumb *container's axId*. We return
    // the breadcrumb NavElement + its ordered members (the
    // breadcrumb items, as the ax-ids in trail order).
    const navElements = g.navElementsByPage(pageIdOfAxId(fromId));
    const breadcrumb = navElements.find(
      (n) => n.kind === "breadcrumb" && n.containerAxId === fromId,
    );
    if (!breadcrumb) {
      return { relation, from: fromId, target: "page", nodes: [] };
    }
    // Return the NavElement + the member ax-ids (resolved to ax
    // nodes if present). The MCP tool flattens this.
    const out: Array<NavElement | AxNode> = [breadcrumb];
    for (const memberAxId of breadcrumb.memberAxIds) {
      const ax = g.getAx(memberAxId);
      if (ax) out.push(ax);
    }
    return { relation, from: fromId, target: "page", nodes: out };
  }

  if (relation === "menu") {
    // The from is the container's axId. We return the
    // menu/menubar/tablist NavElement whose containerAxId matches,
    // plus its member ax-nodes in the NavElement's order.
    const navElements = g.navElementsByPage(pageIdOfAxId(fromId));
    const matching = navElements.filter(
      (n) => n.containerAxId === fromId &&
        (n.kind === "menu" || n.kind === "menubar" || n.kind === "tablist"),
    );
    if (matching.length === 0) {
      return { relation, from: fromId, target: "page", nodes: [] };
    }
    const out: Array<NavElement | AxNode> = [];
    for (const m of matching) {
      out.push(m);
      for (const memberAxId of m.memberAxIds) {
        const ax = g.getAx(memberAxId);
        if (ax) out.push(ax);
      }
    }
    return { relation, from: fromId, target: "page", nodes: out };
  }

  if (relation === "tab-of") {
    // The from is a tab axId. We return the tablist NavElement
    // that contains it. (Per PR-8a T4: tab-of edges go from tab →
    // tablist NavElement.)
    const pageId = pageIdOfAxId(fromId);
    const navElements = g.navElementsByPage(pageId);
    // Look for a tab-of edge from this axId to a NavElement.
    const tabEdges = g.edgesFrom(fromId, "tab-of");
    const out: Array<NavElement | AxNode> = [];
    const seen = new Set<string>();
    for (const e of tabEdges) {
      const nav = g.getNavElement(e.to);
      if (nav && !seen.has(nav.id)) {
        out.push(nav);
        seen.add(nav.id);
      }
    }
    // Also include the tab itself (as an ax-node) so the result
    // surface is self-describing.
    const ax = g.getAx(fromId);
    if (ax) out.push(ax);
    return { relation, from: fromId, target: "page", nodes: out };
  }

  if (!g.getPage(fromId)) {
    return { relation, from: fromId, target: "page", nodes: [] };
  }

  switch (relation) {
    case "children": {
      // Immediate children: outgoing nav:child-of edges.
      const childEdges = g.edgesFrom(fromId, "nav:child-of");
      const out: PageNode[] = [];
      for (const e of childEdges) {
        const n = g.getPage(e.to);
        if (n) out.push(n);
      }
      return { relation, from: fromId, target: "page", nodes: out };
    }
    case "parent": {
      // The single parent: incoming nav:child-of edges.
      const parentEdges = g.edgesTo(fromId, "nav:child-of");
      const p = parentEdges.length > 0 ? g.getPage(parentEdges[0]!.from) ?? null : null;
      return { relation, from: fromId, target: "page", parent: p };
    }
    case "descendants": {
      const depth = clampDepth(opts.depth);
      const out: PageNode[] = [];
      const visited = new Set<string>([fromId]);
      let frontier: Array<{ id: string; hops: number }> = [{ id: fromId, hops: 0 }];
      while (frontier.length) {
        const next: typeof frontier = [];
        for (const { id, hops } of frontier) {
          if (hops >= depth) continue;
          for (const e of g.edgesFrom(id, "nav:child-of")) {
            if (visited.has(e.to)) continue;
            visited.add(e.to);
            const n = g.getPage(e.to);
            if (n) out.push(n);
            next.push({ id: e.to, hops: hops + 1 });
          }
        }
        frontier = next;
      }
      return { relation, from: fromId, target: "page", nodes: out };
    }
    case "ancestors": {
      const depth = clampDepth(opts.depth);
      const out: PageNode[] = [];
      const visited = new Set<string>([fromId]);
      let frontier: Array<{ id: string; hops: number }> = [{ id: fromId, hops: 0 }];
      while (frontier.length) {
        const next: typeof frontier = [];
        for (const { id, hops } of frontier) {
          if (hops >= depth) continue;
          for (const e of g.edgesTo(id, "nav:child-of")) {
            if (visited.has(e.from)) continue;
            visited.add(e.from);
            const n = g.getPage(e.from);
            if (n) out.push(n);
            next.push({ id: e.from, hops: hops + 1 });
          }
        }
        frontier = next;
      }
      return { relation, from: fromId, target: "page", nodes: out };
    }
    default: {
      // PR-8: state-level relations (successors/predecessors/reachable)
      // are dispatched by `relate()` to `relateState` before reaching
      // here. The default is included for type-system completeness.
      return { relation, from: fromId, target: "page", nodes: [] };
    }
  }
}

/**
 * PR-8: state-level traversal. Walks `state:successor` edges over
 * the State graph. Per ED-01 req #6, states form a directed
 * reachability graph — the tree-style relations
 * (children/parent/descendants/ancestors) are NOT supported.
 *
 * Relations supported:
 *   - successors  — 1-hop outgoing `state:successor` edges
 *   - predecessors — 1-hop incoming `state:successor` edges
 *   - reachable   — BFS over `state:successor` to depth (default 5, max 20)
 *   - path        — shortest path BFS over `state:successor`
 */
function relateState(
  g: Graph,
  fromId: string,
  relation: TraversalRelation,
  opts: TraversalOptions,
): TraversalResult {
  // Reject tree-style relations explicitly for the state target.
  if (STATE_DISALLOWED_RELATIONS.has(relation)) {
    return {
      relation,
      from: fromId,
      target: "state",
      nodes: [],
    };
  }
  if (relation === "path") {
    const to = opts.to;
    if (!to) {
      return { relation, from: fromId, target: "state", found: false, hops: [], cost: -1 };
    }
    const r = findStatePath(g, fromId, to, { maxHops: opts.maxHops ?? 20 });
    return { relation, from: fromId, target: "state", ...r };
  }
  if (!g.getState(fromId)) {
    return { relation, from: fromId, target: "state", nodes: [] };
  }
  switch (relation) {
    case "successors": {
      const edges = g.edgesFrom(fromId, "state:successor");
      const out: StateNode[] = [];
      for (const e of edges) {
        const s = g.getState(e.to);
        if (s) out.push(s);
      }
      return { relation, from: fromId, target: "state", nodes: out };
    }
    case "predecessors": {
      const edges = g.edgesTo(fromId, "state:successor");
      const out: StateNode[] = [];
      for (const e of edges) {
        const s = g.getState(e.from);
        if (s) out.push(s);
      }
      return { relation, from: fromId, target: "state", nodes: out };
    }
    case "reachable": {
      const depth = clampDepth(opts.depth);
      const out: StateNode[] = [];
      const visited = new Set<string>([fromId]);
      let frontier: Array<{ id: string; hops: number }> = [{ id: fromId, hops: 0 }];
      while (frontier.length) {
        const next: typeof frontier = [];
        for (const { id, hops } of frontier) {
          if (hops >= depth) continue;
          for (const e of g.edgesFrom(id, "state:successor")) {
            if (visited.has(e.to)) continue;
            visited.add(e.to);
            const s = g.getState(e.to);
            if (s) out.push(s);
            next.push({ id: e.to, hops: hops + 1 });
          }
        }
        frontier = next;
      }
      return { relation, from: fromId, target: "state", nodes: out };
    }
  }
  return { relation, from: fromId, target: "state", nodes: [] };
}

/**
 * Shortest-path BFS over `state:successor` edges between two
 * state ids. Returns a PathResult whose `hops` are state→state
 * edges.
 */
export function findStatePath(
  g: Graph,
  fromStateId: string,
  toStateId: string,
  opts: { maxHops?: number } = {},
): PathResult {
  const maxHops = opts.maxHops ?? 20;
  if (!g.getState(fromStateId) || !g.getState(toStateId)) {
    return { found: false, hops: [], cost: -1 };
  }
  if (fromStateId === toStateId) {
    return { found: true, hops: [], cost: 0 };
  }
  const visited = new Set<string>([fromStateId]);
  const parent = new Map<string, { prev: string; edge: Edge }>();
  const frontier: Array<{ id: string; hops: number }> = [{ id: fromStateId, hops: 0 }];
  while (frontier.length) {
    const { id, hops } = frontier.shift()!;
    if (hops >= maxHops) continue;
    for (const e of g.edgesFrom(id, "state:successor")) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      parent.set(e.to, { prev: id, edge: e });
      if (e.to === toStateId) {
        return reconstruct(parent, fromStateId, toStateId);
      }
      frontier.push({ id: e.to, hops: hops + 1 });
    }
  }
  return { found: false, hops: [], cost: -1 };
}

/**
 * Extract the pageId component from an axId of the form
 * `ax:<pageId>:<rest>`. Per the rest of the codebase the pageId
 * is the full `page:<canonicalUrl>` id (which itself contains
 * colons), so we anchor on the literal `ax:` prefix and
 * `page:` sub-prefix to avoid splitting on a colon inside the URL.
 *
 * Examples (pageId `page:https://example.com/a`):
 *   `ax:page:https://example.com/a:bc-nav` -> `page:https://example.com/a`
 *   `ax:page:https://example.com/a:href:/x` -> `page:https://example.com/a`
 *   `ax:page:https://example.com/a:n3`      -> `page:https://example.com/a`
 *
 * If the input is not an axId of this shape, returns the input
 * unchanged (best-effort).
 */
function pageIdOfAxId(axId: string): string {
  if (!axId.startsWith("ax:page:")) return axId;
  const rest = axId.slice("ax:".length); // "page:https://example.com/a:bc-nav"
  // The ax-local part is the LAST colon-separated segment of the
  // axId. URLs we handle are `scheme://host[:port]/path`; the
  // scheme separator is `://` which contains a colon. Walk from
  // the right past the `://` boundary; the rightmost remaining
  // colon is the pageId boundary.
  const schemeEnd = rest.indexOf("://");
  if (schemeEnd < 0) {
    const colon = rest.indexOf(":");
    return colon < 0 ? rest : rest.slice(0, colon);
  }
  const after = schemeEnd + "://".length;
  let lastColon = -1;
  for (let i = after; i < rest.length; i++) {
    if (rest[i] === ":") lastColon = i;
  }
  return lastColon < 0 ? rest : rest.slice(0, lastColon);
}

// ===OLD_REMOVED===
// (Old _pageIdOfAxId_OLD removed; see the new pageIdOfAxId above.)
/**
 * Shortest path BFS over nav:child-of edges between two page ids.
 * Mirrors findPath (ax-node version) but uses the page edge index and
 * produces PathSteps whose from/to are pageIds.
 */
function findPagePath(
  g: Graph,
  fromPageId: string,
  toPageId: string,
  opts: { maxHops?: number } = {},
): PathResult {
  const maxHops = opts.maxHops ?? 20;
  if (!g.getPage(fromPageId) || !g.getPage(toPageId)) {
    return { found: false, hops: [], cost: -1 };
  }
  if (fromPageId === toPageId) {
    return { found: true, hops: [], cost: 0 };
  }
  const visited = new Set<string>([fromPageId]);
  const parent = new Map<string, { prev: string; edge: Edge }>();
  const frontier: Array<{ id: string; hops: number }> = [{ id: fromPageId, hops: 0 }];
  while (frontier.length) {
    const { id, hops } = frontier.shift()!;
    if (hops >= maxHops) continue;
    for (const e of g.edgesFrom(id, "nav:child-of")) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      parent.set(e.to, { prev: id, edge: e });
      if (e.to === toPageId) {
        return reconstruct(parent, fromPageId, toPageId);
      }
      frontier.push({ id: e.to, hops: hops + 1 });
    }
  }
  return { found: false, hops: [], cost: -1 };
}

function clampDepth(d?: number): number {
  if (d === undefined || d === null) return DEFAULT_DEPTH;
  if (!Number.isFinite(d)) return DEFAULT_DEPTH;
  return Math.max(0, Math.min(MAX_DEPTH, Math.floor(d)));
}

// ---------- graph.tool (capability discovery) ----------

export interface ToolListRequest {
  pageId?: string;
  pageUrl?: string | RegExp;
  name?: string | RegExp;
  securityAtMost?: SecurityTier; // include capabilities whose tier is <= this
}

export interface ToolListResult {
  capabilities: Capability[];
}

export function listTools(g: Graph, req: ToolListRequest): ToolListResult {
  const out: Capability[] = [];
  for (const c of g.capabilities()) {
    if (req.pageId && c.pageId !== req.pageId) continue;
    if (req.pageUrl) {
      const page = g.getPage(c.pageId);
      if (!page || !testStringOrRegex(page.canonicalUrl, req.pageUrl)) continue;
    }
    if (req.name && !testStringOrRegex(c.name, req.name)) continue;
    if (req.securityAtMost && !tierAtMost(c.security, req.securityAtMost)) continue;
    out.push(c);
  }
  return { capabilities: out };
}

// ---------- graph.act (capability invocation — decision only here) ----------

export interface ActRequest {
  capabilityId: string;
  input: Record<string, any>;
  confirm?: boolean;
}

export type ActResult =
  | { ok: true; tier: SecurityTier; capabilityId: string; decision: ActDecision; binding: { axId: string; selector: string; pageId: string } }
  | { ok: false; decision: ActDecision };

export function prepareAct(g: Graph, req: ActRequest): ActResult {
  const cap = g.getCapability(req.capabilityId);
  if (!cap) {
    return {
      ok: false,
      decision: { ok: false, requireConfirm: false, reason: `unknown capability: ${req.capabilityId}` },
    };
  }
  const ax = g.getAx(cap.binding.axId);
  if (!ax) {
    return {
      ok: false,
      decision: { ok: false, requireConfirm: false, reason: `capability's binding axId is missing: ${cap.binding.axId}` },
    };
  }
  const decision = decide({
    tier: cap.security,
    capabilityId: cap.id,
    role: ax.role,
    name: ax.name,
    confirm: req.confirm === true,
  });
  if (!decision.ok) {
    return { ok: false, decision };
  }
  return {
    ok: true,
    tier: cap.security,
    capabilityId: cap.id,
    decision,
    binding: { axId: cap.binding.axId, selector: cap.binding.selector, pageId: cap.pageId },
  };
}

// ---------- graph.explain (provenance / neighborhood) ----------

export interface ExplainRequest {
  id: string;            // any node id, but most useful for axIds
  depth?: number;        // edges to walk, default 2
}

export interface ExplainResult {
  root: { id: string; type: string };
  forward: Array<{ edge: Edge; target: AxNode }>;
  backward: Array<{ edge: Edge; source: AxNode }>;
  page: PageNode | null;
  capabilities: Capability[];
  /**
   * PR-8a: NavElements on the same page as the root ax-node. The
   * explain view should include the Layer 1 *participation* of the
   * element when the root is, e.g., the user-menu button or a tab
   * inside a tablist. Empty array when the page has no NavElements.
   */
  navElements: NavElement[];
}

export function explain(g: Graph, req: ExplainRequest): ExplainResult | null {
  const ax = g.getAx(req.id);
  if (!ax) return null;
  const depth = req.depth ?? 2;
  const page = g.getPage(ax.pageId) ?? null;

  // Forward BFS up to `depth` hops, recording every edge we traverse.
  const visited = new Set<string>([ax.id]);
  const fwdEdges: Array<{ edge: Edge; target: AxNode }> = [];
  let frontier: Array<{ id: string; hops: number }> = [{ id: ax.id, hops: 0 }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const { id, hops } of frontier) {
      if (hops >= depth) continue;
      for (const e of g.edgesFrom(id)) {
        const t = g.getAx(e.to);
        if (!t) continue;
        fwdEdges.push({ edge: e, target: t });
        if (!visited.has(t.id)) {
          visited.add(t.id);
          next.push({ id: t.id, hops: hops + 1 });
        }
      }
    }
    frontier = next;
  }

  // Backward: edges that point into the root, plus one level back of those sources.
  const backEdges: Array<{ edge: Edge; source: AxNode }> = [];
  for (const e of g.edgesTo(ax.id)) {
    const s = g.getAx(e.from);
    if (s) backEdges.push({ edge: e, source: s });
  }

  // Capabilities on the same page.
  const caps = g.capabilitiesByPage(ax.pageId);
  // NavElements on the same page (PR-8a). We include the full list
  // (not just those the root participates in) so an agent reading
  // the explain output can correlate the root with the broader
  // nav structure of the page.
  const navElements = g.navElementsByPage(ax.pageId);

  return {
    root: { id: ax.id, type: "ax-node" },
    forward: fwdEdges,
    backward: backEdges,
    page,
    capabilities: caps,
    navElements,
  };
}

// ---------- Helpers ----------

function testStringOrRegex(s: string, p: string | RegExp): boolean {
  if (p instanceof RegExp) return p.test(s);
  return s.includes(p);
}

const TIER_RANK: Record<SecurityTier, number> = {
  DISCOVER: 0, READ: 1, PROPOSE: 2, EXECUTE: 3, CONFIRM: 4,
};

function tierAtMost(t: SecurityTier, max: SecurityTier): boolean {
  return TIER_RANK[t] <= TIER_RANK[max];
}
