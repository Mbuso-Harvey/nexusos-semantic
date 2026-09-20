/**
 * graph.query — the agent-facing query language. Plan section 9.1.
 *
 * Five operators matter for monetization:
 *  - role / name regex / pageUrl — basic structural filter
 *  - inTether { axId, relation } — the load-bearing visual predicate
 *  - withinViewport { x, y, w, h } — the second load-bearing predicate
 *  - hasCapability { name } — capability cross-link
 *  - reachableFrom { axId, via[] } — ax-node graph traversal
 *
 * Tether semantics (plan section 9.1):
 *  - children: visual nodes whose tethers.parent == given axId
 *  - siblings: visual nodes whose tethers.siblingsBefore/After contains given axId
 *  - parent:   visual node whose tethers.parent == given axId (single hit)
 *  - anchors:  visual nodes whose tethers.anchors[*].target == given axId
 *
 * Viewport predicate matches visual nodes whose rect intersects the viewport rect.
 *
 * **Page-level relations are NOT exposed via `WhereClause`**
 * (PR-7 / ED-03). The `reachableFrom` predicate here walks ax-node edges
 * only. The navigation graph (parent page / child page / ancestors /
 * descendants) is exposed via `graph.path` with `target: "page"`, the
 * same surface decision as ED-04. Keeping the dimensions separate means
 * the `WhereClause` DSL stays ax-node-scoped and the page hierarchy
 * lives on the traversal surface where the a11y tree also lives.
 */
import type { Graph } from "./graph.js";
import type {
  AxNode, VisualNode, Edge, Capability, Transition, PageNode,
  GraphHit, AxRole, ComputedStyleSnapshot, NavElement, NavElementKind,
  StateNode, AuthContext, NetworkContext, ViewportProfile,
  VisualContainerType, VisualPatternType,
} from "./types.js";

export type SelectKind =
  | "page"
  | "ax-node"
  | "visual-node"
  | "edge"
  | "capability"
  | "transition"
  | "nav-element"
  | "state"
  | "any";

export interface WhereClause {
  pageUrl?: string | RegExp;
  role?: AxRole | AxRole[];
  name?: string | RegExp;
  state?: Partial<AxNode["states"]>;
  hasCapability?: string;
  designToken?: string;
  inTether?: { axId: string; relation: "children" | "siblings" | "parent" | "anchors" };
  withinViewport?: { x: number; y: number; w: number; h: number };
  reachableFrom?: { axId: string; via?: string[]; maxHops?: number };
  /**
   * Match a VisualNode by any number of `computedStyle` key/value pairs.
   * All pairs must match exactly. The simplest use is `position: "sticky"`.
   * Added in Stage 17 to support Task 5 (find sticky headers).
   */
  visualStyle?: Partial<ComputedStyleSnapshot>;
  /**
   * VI-01: match a VisualNode by viewport profile name (e.g. "desktop", "mobile")
   * or specific dimensions / dpr.
   */
  viewport?: string | { w?: number; h?: number; dpr?: number };
  /**
   * VI-01: match a VisualNode that becomes hidden at a specific viewport (e.g. "mobile").
   */
  visualHiddenAtViewport?: string;
  /**
   * VI-02: match visual containers / layout wrappers (hero, grid, flex, card, section, scroll, container).
   */
  isVisualContainer?: boolean;
  containerType?: VisualContainerType | VisualContainerType[];
  /**
   * VI-02: match scroll containers (isScrollContainer === true/false).
   */
  isScrollContainer?: boolean;
  /**
   * VI-02: match stacking contexts (isStackingContext === true/false).
   */
  isStackingContext?: boolean;
  /**
   * VI-02: match elements with CSS transforms (hasTransform === true/false).
   */
  hasTransform?: boolean;
  /**
   * VI-02: match elements by box-sizing mode ("border-box" | "content-box").
   */
  boxSizing?: "border-box" | "content-box" | string;
  /**
   * VI-03: match elements that are occluded (visibleRatio < 0.5 or covered by overlapping elements).
   */
  isOccluded?: boolean;
  /**
   * VI-03: match elements with visibleRatio >= minVisibleRatio.
   */
  minVisibleRatio?: number;
  /**
   * VI-03: match elements with visibleRatio <= maxVisibleRatio.
   */
  maxVisibleRatio?: number;
  /**
   * VI-03: match elements that are offscreen / outside viewport.
   */
  isOffscreen?: boolean;
  /**
   * VI-04: match semantic visual patterns (fab, modal-backdrop, sticky-header, sticky-footer, dismiss-button, form-group, toast-notification).
   */
  visualPattern?: VisualPatternType | VisualPatternType[];
  hasPattern?: boolean;
  isFab?: boolean;
  isModalBackdrop?: boolean;
  isStickyHeader?: boolean;
  isStickyFooter?: boolean;
  isDismissButton?: boolean;
  isFormGroup?: boolean;
  /**
   * VI-05: match visual nodes bound to design tokens.
   */
  hasTokenBinding?: boolean;
  tokenPath?: string;
  hasTokenDrift?: boolean;
  driftSeverity?: "low" | "medium" | "high";

  /**
   * PR-8a: match a NavElement by `kind` (e.g. "menu", "tablist",
   * "breadcrumb", "menubar", "tab", "nav-link-set"). Either a single
   * kind or an array.
   */
  navKind?: NavElementKind | NavElementKind[];
  /**
   * PR-8a: match NavElements by page. The value is a pageId
   * (`page:<canonicalUrl>`). Equivalent to filtering the result of
   * `g.navElementsByPage(pageId)` but exposed at the wire for agent
   * composition.
   */
  navInPage?: string;
  /**
   * PR-8: match StateNodes by the page they were observed/declared on.
   * The value is a pageId (`page:<canonicalUrl>`).
   */
  stateOnPage?: string;
  /**
   * PR-8: match StateNodes by auth context kind. The discriminator
   * value of `AuthContext["kind"]`. E.g. `stateAuthKind: "administrator"`
   * returns only states observed under administrator auth.
   */
  stateAuthKind?: AuthContext["kind"];
  /**
   * PR-8: match StateNodes by the network-evidence kind at
   * observation time. One of `bidi:network` (real BiDi network
   * events), `page-instrumented` (fetch/XHR shim), or `static`
   * (no evidence collected; recorded for honesty).
   */
  stateNetworkEvidence?: NetworkContext["evidence"];
  /**
   * PR-8: match StateNodes whose `payload.openDialogIds` includes
   * the given dialog id.
   */
  stateHasOpenDialog?: string;
  /**
   * PR-8: match StateNodes whose `payload.openPopoverIds` includes
   * the given popover id.
   */
  stateHasOpenPopover?: string;
  /**
   * PR-8: match StateNodes by the canonical route recorded in the
   * payload (i.e. `payload.route`). String or RegExp. Matches the
   * agent's mental model: "states observed on the /projects page".
   */
  stateRoute?: string | RegExp;
}

export interface QueryRequest {
  select: SelectKind;
  where?: WhereClause;
  limit?: number;
}

export interface QueryResponse<T = GraphHit> {
  hits: T[];
  truncated: boolean;
  remaining: number;
}

// ---- Implementation ----
export function query(g: Graph, req: QueryRequest): QueryResponse {
  const limit = req.limit ?? 50;
  const where = req.where ?? {};
  const out: GraphHit[] = [];
  let truncated = false;

  const push = (h: GraphHit) => {
    if (out.length >= limit) { truncated = true; return; }
    out.push(h);
  };

  // 1. Resolve the candidate set by select kind.
  // 2. For tether / viewport / reachableFrom we may need to widen the candidate
  //    set to a different select kind; the predicates are explicit about it.

  if (req.select === "any" || req.select === "ax-node") {
    for (const ax of g.axNodes()) {
      if (matchesAxWhere(ax, where, g)) push({ select: "ax-node", node: ax });
    }
  }
  if (req.select === "any" || req.select === "visual-node") {
    for (const v of visualNodesIter(g)) {
      if (matchesVisualWhere(v, where, g)) push({ select: "visual-node", node: v });
    }
  }
  if (req.select === "any" || req.select === "edge") {
    for (const e of allEdges(g)) {
      if (matchesEdgeWhere(e, where, g)) push({ select: "edge", node: e });
    }
  }
  if (req.select === "any" || req.select === "capability") {
    for (const c of g.capabilities()) {
      if (matchesCapabilityWhere(c, where, g)) push({ select: "capability", node: c });
    }
  }
  if (req.select === "any" || req.select === "transition") {
    for (const t of g.transitions()) {
      if (matchesTransitionWhere(t, where, g)) push({ select: "transition", node: t });
    }
  }
  if (req.select === "any" || req.select === "page") {
    for (const p of g.pages()) {
      if (matchesPageWhere(p, where)) push({ select: "page", node: p });
    }
  }
  if (req.select === "any" || req.select === "nav-element") {
    for (const n of navElementsIter(g)) {
      if (matchesNavElementWhere(n, where)) push({ select: "nav-element", node: n });
    }
  }
  if (req.select === "any" || req.select === "state") {
    for (const s of statesIter(g)) {
      if (matchesStateWhere(s, where)) push({ select: "state", node: s });
    }
  }

  // Apply tether / viewport / reachableFrom filters as narrowing steps.
  // For ax-node selects, these can still apply: the axId in inTether is the
  // target, and we filter the candidates to those whose visual has the
  // matching relationship to that target.

  return { hits: out, truncated, remaining: truncated ? -1 : 0 };
}

// ----- Predicate matchers -----

function matchesAxWhere(ax: AxNode, w: WhereClause, g: Graph): boolean {
  if (w.pageUrl) {
    const page = g.getPage(ax.pageId);
    if (!page || !testStringOrRegex(page.canonicalUrl, w.pageUrl)) return false;
  }
  if (w.role) {
    const roles = Array.isArray(w.role) ? w.role : [w.role];
    if (!roles.includes(ax.role)) return false;
  }
  if (w.name && !testStringOrRegex(ax.name, w.name)) return false;
  if (w.state) {
    for (const [k, v] of Object.entries(w.state)) {
      if ((ax.states as any)[k] !== v) return false;
    }
  }
  if (w.hasCapability) {
    if (!pageHasCapability(g, ax.pageId, w.hasCapability)) return false;
  }
  if (w.designToken) {
    const vis = g.visualByAx(ax.id);
    if (!vis || !vis.designTokenRefs.includes(w.designToken)) return false;
  }
  if (w.inTether) {
    const vis = g.visualByAx(ax.id);
    if (!vis) return false;
    if (!tetherMatches(g, vis, w.inTether.axId, w.inTether.relation)) return false;
  }
  if (w.withinViewport) {
    const vis = g.visualByAx(ax.id);
    if (!vis) return false;
    if (!rectIntersects(vis.rect, w.withinViewport)) return false;
  }
  if (w.reachableFrom && !isReachable(g, w.reachableFrom.axId, ax.id, w.reachableFrom.via, w.reachableFrom.maxHops ?? 5)) {
    return false;
  }
  if (w.viewport) {
    const vis = g.visualByAx(ax.id);
    if (!vis) return false;
    const targetName = typeof w.viewport === "string" ? w.viewport.toLowerCase() : null;
    const targetW = typeof w.viewport === "object" ? w.viewport.w : null;
    const vpMatches = (vp?: ViewportProfile) => {
      if (!vp) return false;
      if (targetName && vp.name.toLowerCase() === targetName) return true;
      if (targetW !== null && targetW !== undefined && vp.w === targetW) return true;
      return false;
    };
    const hasVp = vpMatches(vis.viewport) || (vis.viewportObservations && Object.values(vis.viewportObservations).some((obs) => vpMatches(obs.viewport)));
    if (!hasVp) return false;
  }
  if (w.visualHiddenAtViewport) {
    const targetVp = w.visualHiddenAtViewport.toLowerCase();
    const obs = g.visualByAxAndViewport(ax.id, targetVp);
    if (!obs) return false;
    const compStyle = "computedStyle" in obs ? obs.computedStyle : undefined;
    const visibility = "visibility" in obs ? (obs as any).visibility : undefined;
    const isHidden = visibility === "hidden" || visibility === "display-none" || compStyle?.display === "none" || compStyle?.visibility === "hidden";
    if (!isHidden) return false;
  }
  if (w.isVisualContainer !== undefined || w.containerType !== undefined || w.isScrollContainer !== undefined || w.isStackingContext !== undefined || w.hasTransform !== undefined || w.boxSizing !== undefined || w.isOccluded !== undefined || w.minVisibleRatio !== undefined || w.maxVisibleRatio !== undefined || w.isOffscreen !== undefined) {
    const vis = g.visualByAx(ax.id);
    if (!vis) return false;
    if (w.isVisualContainer !== undefined && Boolean(vis.isVisualContainer) !== w.isVisualContainer) return false;
    if (w.containerType !== undefined) {
      const types = Array.isArray(w.containerType) ? w.containerType : [w.containerType];
      if (!vis.containerType || !types.includes(vis.containerType)) return false;
    }
    if (w.isScrollContainer !== undefined && Boolean(vis.scrollClippingContext?.isScrollContainer) !== w.isScrollContainer) return false;
    if (w.isStackingContext !== undefined && Boolean(vis.stackingContext?.isStackingContext) !== w.isStackingContext) return false;
    if (w.hasTransform !== undefined && Boolean(vis.renderBounds?.hasTransform) !== w.hasTransform) return false;
    if (w.boxSizing !== undefined && vis.boxModel?.boxSizing !== w.boxSizing) return false;
    if (w.isOccluded !== undefined && Boolean(vis.occlusion?.isOccluded) !== w.isOccluded) return false;
    if (w.minVisibleRatio !== undefined && (vis.occlusion?.visibleRatio ?? 1) < w.minVisibleRatio) return false;
    if (w.maxVisibleRatio !== undefined && (vis.occlusion?.visibleRatio ?? 1) > w.maxVisibleRatio) return false;
    if (w.isOffscreen !== undefined && Boolean(vis.occlusion?.isOffscreen) !== w.isOffscreen) return false;
  }
  if (w.visualPattern !== undefined || w.hasPattern !== undefined || w.isFab !== undefined || w.isModalBackdrop !== undefined || w.isStickyHeader !== undefined || w.isStickyFooter !== undefined || w.isDismissButton !== undefined || w.isFormGroup !== undefined) {
    const vis = g.visualByAx(ax.id);
    if (!vis) return false;
    if (w.hasPattern !== undefined && (Boolean(vis.patterns && vis.patterns.length > 0) !== w.hasPattern)) return false;
    if (w.visualPattern !== undefined) {
      const pats = Array.isArray(w.visualPattern) ? w.visualPattern : [w.visualPattern];
      const has = vis.patterns?.some((p) => pats.includes(p.pattern));
      if (!has) return false;
    }
    if (w.isFab !== undefined && Boolean(vis.patterns?.some((p) => p.pattern === "fab")) !== w.isFab) return false;
    if (w.isModalBackdrop !== undefined && Boolean(vis.patterns?.some((p) => p.pattern === "modal-backdrop")) !== w.isModalBackdrop) return false;
    if (w.isStickyHeader !== undefined && Boolean(vis.patterns?.some((p) => p.pattern === "sticky-header")) !== w.isStickyHeader) return false;
    if (w.isStickyFooter !== undefined && Boolean(vis.patterns?.some((p) => p.pattern === "sticky-footer")) !== w.isStickyFooter) return false;
    if (w.isDismissButton !== undefined && Boolean(vis.patterns?.some((p) => p.pattern === "dismiss-button")) !== w.isDismissButton) return false;
    if (w.isFormGroup !== undefined && Boolean(vis.patterns?.some((p) => p.pattern === "form-group")) !== w.isFormGroup) return false;
  }
  return true;
}

function matchesVisualWhere(v: VisualNode, w: WhereClause, g: Graph): boolean {
  if (w.pageUrl) {
    const page = g.getPage(v.pageId);
    if (!page || !testStringOrRegex(page.canonicalUrl, w.pageUrl)) return false;
  }
  if (w.role) {
    const ax = g.getAx(v.axId);
    if (!ax) return false;
    const roles = Array.isArray(w.role) ? w.role : [w.role];
    if (!roles.includes(ax.role)) return false;
  }
  if (w.name) {
    const ax = g.getAx(v.axId);
    if (!ax || !testStringOrRegex(ax.name, w.name)) return false;
  }
  if (w.designToken && !v.designTokenRefs.includes(w.designToken)) return false;
  if (w.inTether && !tetherMatches(g, v, w.inTether.axId, w.inTether.relation)) return false;
  if (w.withinViewport && !rectIntersects(v.rect, w.withinViewport)) return false;
  if (w.reachableFrom) {
    const ax = g.getAx(v.axId);
    if (!ax) return false;
    if (!isReachable(g, w.reachableFrom.axId, ax.id, w.reachableFrom.via, w.reachableFrom.maxHops ?? 5)) return false;
  }
  if (w.visualStyle) {
    for (const [k, expected] of Object.entries(w.visualStyle)) {
      if (v.computedStyle[k] !== expected) return false;
    }
  }
  if (w.viewport) {
    const targetName = typeof w.viewport === "string" ? w.viewport.toLowerCase() : null;
    const targetW = typeof w.viewport === "object" ? w.viewport.w : null;
    const vpMatches = (vp?: ViewportProfile) => {
      if (!vp) return false;
      if (targetName && vp.name.toLowerCase() === targetName) return true;
      if (targetW !== null && targetW !== undefined && vp.w === targetW) return true;
      return false;
    };
    const hasVp = vpMatches(v.viewport) || (v.viewportObservations && Object.values(v.viewportObservations).some((obs) => vpMatches(obs.viewport)));
    if (!hasVp) return false;
  }
  if (w.visualHiddenAtViewport) {
    const targetVp = w.visualHiddenAtViewport.toLowerCase();
    const obs = v.viewportObservations?.[targetVp] ?? g.visualByAxAndViewport(v.axId, targetVp);
    if (!obs) return false;
    const compStyle = "computedStyle" in obs ? obs.computedStyle : undefined;
    const visibility = "visibility" in obs ? (obs as any).visibility : undefined;
    const isHidden = visibility === "hidden" || visibility === "display-none" || compStyle?.display === "none" || compStyle?.visibility === "hidden";
    if (!isHidden) return false;
  }
  if (w.isVisualContainer !== undefined && Boolean(v.isVisualContainer) !== w.isVisualContainer) {
    return false;
  }
  if (w.containerType !== undefined) {
    const types = Array.isArray(w.containerType) ? w.containerType : [w.containerType];
    if (!v.containerType || !types.includes(v.containerType)) return false;
  }
  if (w.isScrollContainer !== undefined && Boolean(v.scrollClippingContext?.isScrollContainer) !== w.isScrollContainer) {
    return false;
  }
  if (w.isStackingContext !== undefined && Boolean(v.stackingContext?.isStackingContext) !== w.isStackingContext) {
    return false;
  }
  if (w.hasTransform !== undefined && Boolean(v.renderBounds?.hasTransform) !== w.hasTransform) {
    return false;
  }
  if (w.boxSizing !== undefined && v.boxModel?.boxSizing !== w.boxSizing) {
    return false;
  }
  if (w.isOccluded !== undefined && Boolean(v.occlusion?.isOccluded) !== w.isOccluded) {
    return false;
  }
  if (w.minVisibleRatio !== undefined && (v.occlusion?.visibleRatio ?? 1) < w.minVisibleRatio) {
    return false;
  }
  if (w.maxVisibleRatio !== undefined && (v.occlusion?.visibleRatio ?? 1) > w.maxVisibleRatio) {
    return false;
  }
  if (w.isOffscreen !== undefined && Boolean(v.occlusion?.isOffscreen) !== w.isOffscreen) {
    return false;
  }
  if (w.visualPattern !== undefined) {
    const pats = Array.isArray(w.visualPattern) ? w.visualPattern : [w.visualPattern];
    const has = v.patterns?.some((p) => pats.includes(p.pattern));
    if (!has) return false;
  }
  if (w.hasPattern !== undefined && (Boolean(v.patterns && v.patterns.length > 0) !== w.hasPattern)) {
    return false;
  }
  if (w.isFab !== undefined && Boolean(v.patterns?.some((p) => p.pattern === "fab")) !== w.isFab) {
    return false;
  }
  if (w.isModalBackdrop !== undefined && Boolean(v.patterns?.some((p) => p.pattern === "modal-backdrop")) !== w.isModalBackdrop) {
    return false;
  }
  if (w.isStickyHeader !== undefined && Boolean(v.patterns?.some((p) => p.pattern === "sticky-header")) !== w.isStickyHeader) {
    return false;
  }
  if (w.isStickyFooter !== undefined && Boolean(v.patterns?.some((p) => p.pattern === "sticky-footer")) !== w.isStickyFooter) {
    return false;
  }
  if (w.isDismissButton !== undefined && Boolean(v.patterns?.some((p) => p.pattern === "dismiss-button")) !== w.isDismissButton) {
    return false;
  }
  if (w.isFormGroup !== undefined && Boolean(v.patterns?.some((p) => p.pattern === "form-group")) !== w.isFormGroup) {
    return false;
  }
  if (w.hasTokenBinding !== undefined) {
    const hasBinding = Boolean((v.designTokenBindings && v.designTokenBindings.length > 0) || v.designTokenRefs.length > 0);
    if (hasBinding !== w.hasTokenBinding) return false;
  }
  if (w.tokenPath !== undefined) {
    const matchesPath = (v.designTokenBindings && v.designTokenBindings.some((b) => b.tokenPath === w.tokenPath)) ||
      v.designTokenRefs.includes(w.tokenPath);
    if (!matchesPath) return false;
  }
  if (w.hasTokenDrift !== undefined) {
    const hasDrift = Boolean(v.tokenDrifts && v.tokenDrifts.length > 0);
    if (hasDrift !== w.hasTokenDrift) return false;
  }
  if (w.driftSeverity !== undefined) {
    const hasSev = v.tokenDrifts?.some((d) => d.severity === w.driftSeverity);
    if (!hasSev) return false;
  }
  return true;
}

function matchesEdgeWhere(e: Edge, w: WhereClause, g: Graph): boolean {
  if (w.pageUrl) {
    const fromAx = g.getAx(e.from);
    if (!fromAx) return false;
    const page = g.getPage(fromAx.pageId);
    if (!page || !testStringOrRegex(page.canonicalUrl, w.pageUrl)) return false;
  }
  return true;
}

function matchesCapabilityWhere(c: Capability, w: WhereClause, g: Graph): boolean {
  if (w.pageUrl) {
    const page = g.getPage(c.pageId);
    if (!page || !testStringOrRegex(page.canonicalUrl, w.pageUrl)) return false;
  }
  if (w.name && !testStringOrRegex(c.name, w.name)) return false;
  if (w.hasCapability && !testStringOrRegex(c.name, w.hasCapability)) return false;
  return true;
}

function matchesTransitionWhere(t: Transition, w: WhereClause, g: Graph): boolean {
  if (w.pageUrl) {
    const fromAx = g.getAx(t.fromAxId);
    if (!fromAx) return false;
    const page = g.getPage(fromAx.pageId);
    if (!page || !testStringOrRegex(page.canonicalUrl, w.pageUrl)) return false;
  }
  return true;
}

function matchesPageWhere(p: PageNode, w: WhereClause): boolean {
  if (w.pageUrl && !testStringOrRegex(p.canonicalUrl, w.pageUrl)) return false;
  if (w.name && !testStringOrRegex(p.title, w.name)) return false;
  return true;
}

// PR-8: matcher for StateNode. Exposes the auth/network/route/page
// predicates added in PR-8. The DSL is intentionally narrow — state
// nodes are queried most often by "where on the site was this state
// observed?" and "under what auth context?", not by per-element
// payload inspection.
function matchesStateWhere(s: StateNode, w: WhereClause): boolean {
  if (w.stateOnPage && s.pageId !== w.stateOnPage) return false;
  if (w.stateAuthKind && s.authContext.kind !== w.stateAuthKind) return false;
  if (w.stateNetworkEvidence && s.networkContext.evidence !== w.stateNetworkEvidence) return false;
  if (w.stateHasOpenDialog && !s.payload.openDialogIds.includes(w.stateHasOpenDialog)) return false;
  if (w.stateHasOpenPopover && !s.payload.openPopoverIds.includes(w.stateHasOpenPopover)) return false;
  if (w.stateRoute && !testStringOrRegex(s.payload.route, w.stateRoute)) return false;
  return true;
}

// PR-8a: matcher for NavElement nodes. Exposes `navKind` and
// `navInPage` predicates. The `name` predicate matches against
// NavElement.name (which is the aria-label / textContent of the
// container) so an agent can write a single query like
//   { select: "nav-element", where: { navKind: "menu", name: "user" } }.
function matchesNavElementWhere(n: NavElement, w: WhereClause): boolean {
  if (w.navInPage && n.pageId !== w.navInPage) return false;
  if (w.navKind) {
    const kinds = Array.isArray(w.navKind) ? w.navKind : [w.navKind];
    if (!kinds.includes(n.kind)) return false;
  }
  if (w.name) {
    if (!n.name) return false;
    if (!testStringOrRegex(n.name, w.name)) return false;
  }
  return true;
}

// ----- Tether predicate (load-bearing for monetization) -----
//
// Semantics, re-stated from the plan section 9.1 header:
//   children: visual nodes whose tethers.parent is the visual of targetAxId
//   parent:   the (single) visual node whose tethers.children includes the visual of targetAxId
//   siblings: visual nodes that share a parent with the visual of targetAxId
//   anchors:  visual nodes whose tethers.anchors[*].target == targetAxId

function tetherMatches(g: Graph, v: VisualNode, targetAxId: string, relation: "children" | "siblings" | "parent" | "anchors"): boolean {
  const targetVis = g.visualByAx(targetAxId);
  switch (relation) {
    case "parent": {
      // Candidate v is the parent of the target axId iff target's visual's
      // tethers.parent points to v (i.e. v is the visId parent of targetVis).
      if (!targetVis) return false;
      return targetVis.tethers.parent === v.id;
    }
    case "children": {
      // Candidate v is a child of target axId iff v's tethers.parent points
      // to target's visual.
      if (!targetVis) return false;
      return v.tethers.parent === targetVis.id;
    }
    case "siblings": {
      // Siblings share a parent. Both v and targetVis must be children of the
      // same parent visual.
      if (!targetVis) return false;
      if (v.id === targetVis.id) return false;
      return v.tethers.parent !== null && v.tethers.parent === targetVis.tethers.parent;
    }
    case "anchors":
      return v.tethers.anchors.some((a) => a.target === targetAxId);
  }
}

// ----- Rect intersection -----

function rectIntersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

// ----- BFS reachability -----
// Returns true iff `toAxId` is reachable from `fromAxId` via at least one
// edge (i.e. NOT the same node). Used by the reachableFrom where-clause to
// include only nodes that are *neighbors* in the graph, not the root itself.

function isReachable(g: Graph, fromAxId: string, toAxId: string, viaKinds?: string[], maxHops: number = 5): boolean {
  if (fromAxId === toAxId) return false;
  const visited = new Set<string>([fromAxId]);
  const frontier: Array<{ id: string; hops: number }> = [{ id: fromAxId, hops: 0 }];
  while (frontier.length) {
    const { id, hops } = frontier.shift()!;
    if (hops >= maxHops) continue;
    const out = g.edgesFrom(id);
    for (const e of out) {
      if (viaKinds && viaKinds.length > 0 && !viaKinds.includes(e.kind)) continue;
      if (e.to === toAxId) return true;
      if (!visited.has(e.to)) {
        visited.add(e.to);
        frontier.push({ id: e.to, hops: hops + 1 });
      }
    }
  }
  return false;
}

// ----- Helpers -----

function testStringOrRegex(s: string, p: string | RegExp): boolean {
  if (p instanceof RegExp) return p.test(s);
  return s.includes(p);
}

function pageHasCapability(g: Graph, pageId: string, namePattern: string): boolean {
  const re = toMaybeRegex(namePattern);
  for (const c of g.capabilitiesByPage(pageId)) {
    if (re.test(c.name)) return true;
  }
  return false;
}

function toMaybeRegex(s: string): RegExp {
  // Very small mini-DSL: prefix "*" means "ends with", suffix "*" means "starts with", bare = substring
  if (s.startsWith("*") && s.endsWith("*")) return new RegExp(escapeRegex(s.slice(1, -1)), "i");
  if (s.startsWith("*")) return new RegExp(escapeRegex(s.slice(1)) + "$", "i");
  if (s.endsWith("*")) return new RegExp("^" + escapeRegex(s.slice(0, -1)), "i");
  return new RegExp(escapeRegex(s), "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Safe iteration over visual nodes (the graph exposes visualNodes via a page-index).
function* visualNodesIter(g: Graph): IterableIterator<VisualNode> {
  for (const p of g.pages()) {
    for (const v of g.visualByPage(p.id)) yield v;
  }
}

// PR-8a: iterate every NavElement across every page. The graph
// exposes a page-index via navElementsByPage; the query dispatch
// walks the same index so the iteration order is stable.
function* navElementsIter(g: Graph): IterableIterator<NavElement> {
  for (const p of g.pages()) {
    for (const n of g.navElementsByPage(p.id)) yield n;
  }
}

// PR-8: iterate every StateNode. The graph exposes a direct
// `states()` iterator; we use it for simplicity. Order is insertion
// order, which is deterministic across save/load round-trips.
function* statesIter(g: Graph): IterableIterator<StateNode> {
  for (const s of g.states()) yield s;
}

function* allEdges(g: Graph): IterableIterator<Edge> {
  for (const ax of g.axNodes()) {
    for (const e of g.edgesFrom(ax.id)) yield e;
  }
}
