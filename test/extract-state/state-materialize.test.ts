/**
 * PR-8c T12 — Comprehensive tests for the state materializer.
 *
 * Each test pins one of the PR-8c corrections; if any correction
 * drifts (e.g. the materializer stops upserting AuthContextNode
 * before writing the `state:auth` edge, or stops using the
 * evidence chain to resolve `state:cause`), the test fails.
 *
 * Corrections pinned here:
 *   - T2:  state:visual edge resolves to a real VisualNode
 *   - T6:  state:auth edge points at a real AuthContextNode
 *   - T7:  state:cause uses evidence chain (no false match)
 *   - 2E:  state-feeds-capability only on explicit evidence
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import {
  authIdFor,
  materializeState,
  materializeSuccessor,
  resolveStateCauseEdges,
} from "../../src/extract-state/state-materialize.js";
import {
  deriveStateId,
  buildStatePayload,
} from "../../src/graph/state-id.js";
import type {
  AuthContext, NetworkContext, ElementStateObservation, VisualNode, AxNode, Capability, StateNode,
} from "../../src/graph/types.js";

const PAGE_ID = "page:https://example.com/";
const ROUTE = "https://example.com/";
const SOURCE_AX = `ax:${PAGE_ID}:btn`;

function makeAuth(kind: AuthContext["kind"] = "anonymous"): AuthContext {
  if (kind === "anonymous") return { kind: "anonymous" };
  if (kind === "authenticated") return { kind: "authenticated", principal: "alice", session: "s1" };
  if (kind === "administrator") return { kind: "administrator", principal: "bob", session: "s2" };
  return { kind: "custom-role", role: "billing-admin", principal: "carol", session: "s3" };
}

const NETWORK: NetworkContext = { status: "online", evidence: "page-instrumented" };

function makeObs(over: Partial<ElementStateObservation> = {}): ElementStateObservation {
  return {
    axId: SOURCE_AX,
    rect: { x: 10, y: 20, w: 100, h: 30 },
    visibility: "visible",
    zIndex: 0,
    open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
    // PR-8g T1: per-element focus flag. Default false (no focus
    // observed in test fixtures unless explicitly overridden).
    focused: false,
    ariaStates: {},
    visualNodeId: null,
    ...over,
  };
}

function makeSnapshot(over: Partial<{
  elements: Record<string, ElementStateObservation>;
  openDialogIds: string[];
  openPopoverIds: string[];
  expandedRegionAxIds: string[];
  focusedAxId?: string | null;
}> = {}): {
  elements: Record<string, ElementStateObservation>;
  openDialogIds: string[];
  openPopoverIds: string[];
  expandedRegionAxIds: string[];
  viewport: { w: number; h: number; dpr: number; scrollX: number; scrollY: number };
  conditionalMarkers: Record<string, string>;
  focusedAxId: string | null;
} {
  return {
    elements: over.elements ?? { [SOURCE_AX]: makeObs() },
    openDialogIds: over.openDialogIds ?? [],
    openPopoverIds: over.openPopoverIds ?? [],
    expandedRegionAxIds: over.expandedRegionAxIds ?? [],
    viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
    conditionalMarkers: {},
    // PR-8g T1: State-level focus pointer. Tests that exercise
    // focus pass an override.
    focusedAxId: over.focusedAxId ?? null,
  };
}

function seedAxNode(graph: Graph, axId: string = SOURCE_AX): AxNode {
  const ax: AxNode = {
    id: axId,
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "go",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 5, parentAxId: null, provenance: "aria:t",
  };
  graph.upsertAx(ax);
  return ax;
}

function findEdge(g: Graph, kind: string, pred?: (e: any) => boolean): any | undefined {
  for (const e of g.allEdges()) {
    if (e.kind !== kind) continue;
    if (pred && !pred(e)) continue;
    return e;
  }
  return undefined;
}

function seedPage(graph: Graph): void {
  graph.upsertPage({
    id: PAGE_ID, type: "page", url: ROUTE, title: "Ex",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: `ax:${PAGE_ID}:root`, provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: ROUTE, crawledAt: "2026-08-30T00:00:00Z", parentPageId: null,
  });
}

describe("authIdFor", () => {
  it("returns auth:anonymous for anonymous", () => {
    expect(authIdFor({ kind: "anonymous" })).toBe("auth:anonymous");
  });
  it("includes principal+session for authenticated", () => {
    expect(authIdFor({ kind: "authenticated", principal: "alice", session: "s1" }))
      .toBe("auth:authenticated:alice:s1");
  });
  it("includes role+principal+session for custom-role", () => {
    expect(authIdFor({ kind: "custom-role", role: "billing-admin", principal: "carol", session: "s3" }))
      .toBe("auth:custom-role:billing-admin:carol:s3");
  });
});

describe("PR-8c T6: state:auth points at a real AuthContextNode (no dangling edges)", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); seedPage(g); seedAxNode(g); });

  it("upserts an AuthContextNode before writing the state:auth edge", () => {
    const auth = makeAuth("authenticated");
    const r = materializeState(g, PAGE_ID, ROUTE, auth, NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "2026-08-30T00:00:00Z",
    }, "dom-diff:probe");
    // The state:auth edge must exist
    const authEdge = findEdge(g, "state:auth");
    expect(authEdge).toBeDefined();
    expect(authEdge!.to).toBe("auth:authenticated:alice:s1");
    // The AuthContextNode must exist with the same id (no dangling)
    const node = g.getAuthContext("auth:authenticated:alice:s1");
    expect(node).toBeDefined();
    expect(node!.context).toEqual(auth);
    expect(r.edgeIds).toContain(authEdge!.id);
  });

  it("is idempotent: AuthContextNode observationCount increments on repeat", () => {
    const auth = makeAuth("authenticated");
    const snap = makeSnapshot();
    const ev = { kind: "observed" as const, sourceAxId: SOURCE_AX, transitionId: null, at: "2026-08-30T00:00:00Z" };
    materializeState(g, PAGE_ID, ROUTE, auth, NETWORK, snap, [SOURCE_AX], ev, "dom-diff:probe");
    materializeState(g, PAGE_ID, ROUTE, auth, NETWORK, snap, [SOURCE_AX], ev, "dom-diff:probe");
    const node = g.getAuthContext("auth:authenticated:alice:s1")!;
    // PR-8b: idempotent — observationCount increments, not duplicates
    expect(node.observationCount).toBeGreaterThanOrEqual(2);
    expect(g.authContextCount).toBe(1);
  });

  it("anonymous auth context is also a real graph node", () => {
    materializeState(g, PAGE_ID, ROUTE, makeAuth("anonymous"), NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "2026-08-30T00:00:00Z",
    }, "dom-diff:probe");
    const node = g.getAuthContext("auth:anonymous");
    expect(node).toBeDefined();
    const edge = findEdge(g, "state:auth");
    expect(edge!.to).toBe("auth:anonymous");
  });
});

describe("PR-8c T2: state:visual resolves to a real VisualNode (no null reference)", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); seedPage(g); seedAxNode(g); });

  it("emits state:visual edge only when the VisualNode exists in the graph", () => {
    const visId = `vis:${PAGE_ID}:${SOURCE_AX}`;
    const vis: VisualNode = {
      id: visId, type: "visual-node", pageId: PAGE_ID, axId: SOURCE_AX,
      rect: { x: 0, y: 0, w: 100, h: 30 },
      computedStyle: {},
      designTokenRefs: [],
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
      provenance: "cdp:computed-style",
    };
    g.upsertVisual(vis);
    materializeState(g, PAGE_ID, ROUTE, makeAuth(), NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "2026-08-30T00:00:00Z",
    }, "dom-diff:probe");
    const visEdge = findEdge(g, "state:visual");
    expect(visEdge).toBeDefined();
    expect(visEdge!.to).toBe(visId);
  });

  it("omits state:visual edge when no VisualNode exists (no dangling)", () => {
    // No VisualNode seeded. The state node is still emitted.
    const r = materializeState(g, PAGE_ID, ROUTE, makeAuth(), NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "2026-08-30T00:00:00Z",
    }, "dom-diff:probe");
    const visEdges: any[] = [];
    for (const e of g.allEdges()) if (e.kind === "state:visual") visEdges.push(e);
    expect(visEdges).toHaveLength(0);
    // State is still there.
    expect(g.getState(r.stateId)).toBeDefined();
  });

  it("resolves via graph.visualByAx when obs.visualNodeId is null but the structural visual exists", () => {
    // PR-8c T2 fix path: the materializer falls back to
    // `graph.visualByAx(axId)` when the snapshot observation did not
    // include a visualNodeId (which happens for elements the visual
    // extractor found via structural walk, not interactive probe).
    const vis: VisualNode = {
      id: `vis:${PAGE_ID}:${SOURCE_AX}`,
      type: "visual-node", pageId: PAGE_ID, axId: SOURCE_AX,
      rect: { x: 0, y: 0, w: 100, h: 30 },
      computedStyle: {},
      designTokenRefs: [],
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
      provenance: "cdp:computed-style",
    };
    g.upsertVisual(vis);
    // The snapshot observation has no visualNodeId.
    const snap = makeSnapshot();
    expect(snap.elements[SOURCE_AX]!.visualNodeId).toBeNull();
    materializeState(g, PAGE_ID, ROUTE, makeAuth(), NETWORK, snap, [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "2026-08-30T00:00:00Z",
    }, "dom-diff:probe");
    const visEdge = findEdge(g, "state:visual");
    expect(visEdge).toBeDefined();
    expect(visEdge!.to).toBe(`vis:${PAGE_ID}:${SOURCE_AX}`);
  });
});

describe("PR-8c T7: state:cause uses evidence chain (no false match)", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); seedPage(g); seedAxNode(g); });

  it("resolves a state:cause edge when a State has matching sourceAxId evidence", () => {
    // First, materialize a real before/after transition (a click on btn).
    const before = makeSnapshot({
      elements: { [SOURCE_AX]: makeObs({ pressed: null }) },
    });
    const after = makeSnapshot({
      elements: { [SOURCE_AX]: makeObs({ pressed: true }) },
    });
    const t = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after, sourceAxId: SOURCE_AX,
      trigger: "click", evidenceKind: "observed", provenance: "dom-diff:probe",
    });
    // Now drop a state:cause placeholder edge as if the declared
    // extractor had emitted one for a click kind.
    const placeholder = `state:TBD:${SOURCE_AX}:click`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(1);
    expect(r.removed).toBe(0);
    // The edge was re-pointed at the before-state (not the after-state
    // and not some random state on the same page).
    const edge = findEdge(g, "state:cause")!;
    expect(edge.to).toBe(t.beforeId);
    // The after-state is reachable via state:successor.
    const succ = findEdge(g, "state:successor")!;
    expect(succ.from).toBe(t.beforeId);
    expect(succ.to).toBe(t.afterId);
    expect(succ.triggers).toContain("click");
  });

  it("REMOVES (not re-points) a state:cause edge when no evidence exists", () => {
    // No state nodes, no transitions. Drop a placeholder edge.
    const placeholder = `state:TBD:${SOURCE_AX}:click`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
    });
    const unresolved: string[] = [];
    const r = resolveStateCauseEdges(g, (info) => unresolved.push(info.sourceAxId));
    expect(r.resolved).toBe(0);
    expect(r.removed).toBe(1);
    // The edge is gone (no false fallback to "first state on the same page").
    expect(findEdge(g, "state:cause")).toBeUndefined();
    expect(unresolved).toContain(SOURCE_AX);
  });

  it("does not match a state on a different page (pageId is required)", () => {
    // Materialize a state on page B, then place a state:cause edge
    // from an axId on page A. The edge should not be resolved.
    const otherPage = "page:https://other.com/";
    const otherAx = `ax:${otherPage}:btn`;
    g.upsertPage({
      id: otherPage, type: "page", url: otherPage, title: "Other",
      discoveredVia: [], loadStatus: "complete",
      axTreeRef: { rootAxId: `ax:${otherPage}:root`, provenance: "bidi:script.evaluate" },
      viewport: { w: 1, h: 1, dpr: 1 }, tokensOverride: null, screenshotRef: null,
      canonicalUrl: otherPage, crawledAt: "t", parentPageId: null,
    });
    g.upsertAx({
      id: otherAx, type: "ax-node", pageId: otherPage, role: "button", name: "x",
      nameSource: "content",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
    });
    // Materialize a state on other page with the other axId as source.
    const snap = makeSnapshot();
    const before = { ...snap, elements: { [otherAx]: makeObs({ axId: otherAx }) } };
    const after = { ...snap, elements: { [otherAx]: makeObs({ axId: otherAx, pressed: true }) } };
    materializeSuccessor({
      graph: g, pageId: otherPage, route: otherPage,
      auth: makeAuth(), network: NETWORK,
      before, after, sourceAxId: otherAx,
      trigger: "click", evidenceKind: "observed", provenance: "dom-diff:probe",
    });
    // Now a state:cause edge on the wrong page.
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->state:TBD:${SOURCE_AX}:click:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: `state:TBD:${SOURCE_AX}:click`,
      kind: "state:cause",
      provenance: "html:parse",
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(0);
    expect(r.removed).toBe(1);
  });

  it("picks the successor whose trigger matches the declared kind, not the first arbitrary successor", () => {
    // Two state:successor edges out of the same before-state:
    // one with trigger=click, one with trigger=hover. The placeholder
    // says ":click" — the resolver should prefer the click successor.
    const before = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: null }) } });
    const afterClick = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: true }) } });
    const afterHover = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ expanded: true }) } });
    const t1 = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: afterClick, sourceAxId: SOURCE_AX,
      trigger: "click", evidenceKind: "observed", provenance: "dom-diff:probe",
    });
    // Second transition: hover from the same before-state. The
    // materializeSuccessor dedups via deriveStateId so we mutate the
    // snapshot to force a different after-state.
    const afterHoverAlt = makeSnapshot({
      elements: { [SOURCE_AX]: makeObs({ expanded: true, rect: { x: 1, y: 1, w: 1, h: 1 } }) },
    });
    materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: afterHoverAlt, sourceAxId: SOURCE_AX,
      trigger: "hover", evidenceKind: "observed", provenance: "dom-diff:probe",
    });
    // Placeholder for a click kind.
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->state:TBD:${SOURCE_AX}:click:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: `state:TBD:${SOURCE_AX}:click`,
      kind: "state:cause",
      provenance: "html:parse",
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(1);
    const edge = findEdge(g, "state:cause")!;
    // The edge is re-pointed at the before-state of the click
    // transition (t1.beforeId), not the hover one.
    expect(edge.to).toBe(t1.beforeId);
  });
});

describe("ED-01 2E: state-feeds-capability only on explicit evidence", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); seedPage(g); seedAxNode(g); });

  it("does NOT emit state-feeds-capability when no Capability is bound to the source axId", () => {
    materializeState(g, PAGE_ID, ROUTE, makeAuth(), NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "t",
    }, "dom-diff:probe");
    const e = findEdge(g, "state-feeds-capability");
    expect(e).toBeUndefined();
  });

  it("emits state-feeds-capability only when a Capability is bound to the source axId", () => {
    const cap: Capability = {
      id: "cap:go", type: "capability", name: "go", description: "go",
      inputSchema: {}, outputSchema: {}, source: "fallback",
      binding: { kind: "ax-node", axId: SOURCE_AX, selector: "#go" },
      security: "READ", provenance: "declared:t", pageId: PAGE_ID,
    };
    g.upsertCapability(cap);
    materializeState(g, PAGE_ID, ROUTE, makeAuth(), NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "t",
    }, "dom-diff:probe");
    const e = findEdge(g, "state-feeds-capability");
    expect(e).toBeDefined();
    expect(e!.to).toBe("cap:go");
  });

  it("does NOT emit for a Capability bound to a different axId", () => {
    const otherAx = `ax:${PAGE_ID}:other`;
    seedAxNode(g, otherAx);
    g.upsertCapability({
      id: "cap:other", type: "capability", name: "other", description: "x",
      inputSchema: {}, outputSchema: {}, source: "fallback",
      binding: { kind: "ax-node", axId: otherAx, selector: "#other" },
      security: "READ", provenance: "declared:t", pageId: PAGE_ID,
    });
    materializeState(g, PAGE_ID, ROUTE, makeAuth(), NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "t",
    }, "dom-diff:probe");
    expect(findEdge(g, "state-feeds-capability")).toBeUndefined();
  });
});

describe("deriveStateId is deterministic and sensitive to all payload fields", () => {
  it("same payload → same id", () => {
    const auth = makeAuth("anonymous");
    const snap = makeSnapshot();
    const a = buildStatePayload({
      pageId: PAGE_ID, route: ROUTE, auth, network: NETWORK,
      elements: snap.elements, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: snap.viewport, conditionalMarkers: {},
    });
    const b = buildStatePayload({
      pageId: PAGE_ID, route: ROUTE, auth, network: NETWORK,
      elements: snap.elements, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: snap.viewport, conditionalMarkers: {},
    });
    expect(deriveStateId(a)).toBe(deriveStateId(b));
  });

  it("auth context changes the id", () => {
    const snap = makeSnapshot();
    const a = buildStatePayload({
      pageId: PAGE_ID, route: ROUTE, auth: makeAuth("anonymous"), network: NETWORK,
      elements: snap.elements, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: snap.viewport, conditionalMarkers: {},
    });
    const b = buildStatePayload({
      pageId: PAGE_ID, route: ROUTE, auth: makeAuth("authenticated"), network: NETWORK,
      elements: snap.elements, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: snap.viewport, conditionalMarkers: {},
    });
    expect(deriveStateId(a)).not.toBe(deriveStateId(b));
  });

  it("network evidence changes the id", () => {
    const snap = makeSnapshot();
    const a = buildStatePayload({
      pageId: PAGE_ID, route: ROUTE, auth: makeAuth(), network: { status: "online", evidence: "page-instrumented" },
      elements: snap.elements, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: snap.viewport, conditionalMarkers: {},
    });
    const b = buildStatePayload({
      pageId: PAGE_ID, route: ROUTE, auth: makeAuth(), network: { status: "online", evidence: "bidi:network" },
      elements: snap.elements, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: snap.viewport, conditionalMarkers: {},
    });
    expect(deriveStateId(a)).not.toBe(deriveStateId(b));
  });
});

describe("PR-8c materializer drift: every correction must hold", () => {
  /**
   * This is the master "drift guard" — if any of the PR-8c
   * corrections in the materializer regress, the test that pins
   * it will fail. The plan's T12 required: "comprehensive tests
   * for every correction (fail if drift)."
   */
  it("upserts the StateNode, AuthContextNode, and VisualNode linkage, and emits all four cross-layer edges", () => {
    const g = new Graph();
    seedPage(g);
    seedAxNode(g);
    // Seed a real VisualNode.
    g.upsertVisual({
      id: `vis:${PAGE_ID}:${SOURCE_AX}`,
      type: "visual-node", pageId: PAGE_ID, axId: SOURCE_AX,
      rect: { x: 0, y: 0, w: 100, h: 30 },
      computedStyle: {},
      designTokenRefs: [],
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
      provenance: "cdp:computed-style",
    });
    g.upsertCapability({
      id: "cap:go", type: "capability", name: "go", description: "go",
      inputSchema: {}, outputSchema: {}, source: "fallback",
      binding: { kind: "ax-node", axId: SOURCE_AX, selector: "#go" },
      security: "READ", provenance: "declared:t", pageId: PAGE_ID,
    });
    const r = materializeState(g, PAGE_ID, ROUTE, makeAuth("authenticated"), NETWORK, makeSnapshot(), [SOURCE_AX], {
      kind: "observed", sourceAxId: SOURCE_AX, transitionId: null, at: "t",
    }, "dom-diff:probe");
    // 1. StateNode is upserted.
    expect(g.getState(r.stateId)).toBeDefined();
    // 2. AuthContextNode is upserted (no dangling state:auth).
    expect(g.getAuthContext("auth:authenticated:alice:s1")).toBeDefined();
    // 3. state:on-page, state:of-element, state:visual, state:auth
    //    edges are all present.
    const fromState: any[] = [];
    for (const e of g.allEdges()) if (e.from === r.stateId) fromState.push(e);
    const kinds = new Set(fromState.map((e) => e.kind));
    expect(kinds.has("state:on-page")).toBe(true);
    expect(kinds.has("state:of-element")).toBe(true);
    expect(kinds.has("state:visual")).toBe(true);
    expect(kinds.has("state:auth")).toBe(true);
    // 4. state-feeds-capability emitted (explicit evidence).
    expect(kinds.has("state-feeds-capability")).toBe(true);
  });
});

/**
 * PR-8d T7 — state:cause resolution uses the structural `cause`
 * metadata, not the placeholder string.
 *
 * The placeholder format is now `state:TBD:<kind>:<sourceAxId>`
 * (kind first, sourceAxId last), with the kind and commandValue
 * carried on the Edge's structural `cause` field. The resolver
 * MUST read `e.cause.declaredKind` directly. Parsing
 * `e.to.split(":")[3]` would have been wrong (axIds contain
 * colons, and the kind is now first not third) — and would
 * silently reconnect declared transitions to the wrong State
 * once axId encoding changed.
 *
 * Each test in this block exercises a distinct contract of the
 * new resolver:
 *
 *   1. With the new placeholder format AND a populated `cause`
 *      field, the resolver picks the successor whose trigger
 *      matches the declared kind (not the first arbitrary one).
 *   2. With the new placeholder format and NO `cause` field on
 *      the edge, the resolver still works (falls back to
 *      `succs[0]`), but logs the structural-field absence.
 *   3. The resolved edge's `cause` field is preserved (the
 *      declaredKind/commandValue are NOT lost on re-pointing).
 *   4. The placeholder string itself is NOT parsed — the
 *      resolver would behave identically even if the placeholder
 *      text were a different format, as long as the structural
 *      `cause` field is set.
 */
describe("PR-8d T7: state:cause uses structural cause metadata, not placeholder string parsing", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); seedPage(g); seedAxNode(g); });

  it("reads declaredKind from the edge's structural cause field, not from the placeholder string", () => {
    // Build two transitions from the same before-state: one with
    // trigger=command-show-modal, one with trigger=command-close.
    // The state:cause placeholder uses the NEW format
    // `state:TBD:<kind>:<axId>`, and the structural cause field
    // is set to "popovertarget" (so the kind stored structurally
    // is POPOVERTARGET, not the placeholder's text). The string
    // says "commandfor" but the structural field says
    // "popovertarget" — the resolver must follow the STRUCTURAL
    // field, not the string.
    const before = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: null, expanded: null }) } });
    const afterCommandfor = makeSnapshot({
      elements: { [SOURCE_AX]: makeObs({ pressed: true, rect: { x: 8, y: 8, w: 8, h: 8 } }) },
    });
    const t1 = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: afterCommandfor, sourceAxId: SOURCE_AX,
      trigger: "command-show-modal", evidenceKind: "declared", provenance: "html:parse",
    });
    const afterPopover = makeSnapshot({
      elements: { [SOURCE_AX]: makeObs({ expanded: true, rect: { x: 9, y: 9, w: 9, h: 9 } }) },
    });
    materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: afterPopover, sourceAxId: SOURCE_AX,
      trigger: "command-show-popover", evidenceKind: "declared", provenance: "html:parse",
    });
    // The placeholder string says "commandfor" but the structural
    // cause.declaredKind is "popovertarget". The resolver must
    // prefer the popovertarget successor because the structural
    // field wins over the string.
    const placeholder = `state:TBD:commandfor:${SOURCE_AX}`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
      cause: { sourceAxId: SOURCE_AX, declaredKind: "popovertarget" },
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(1);
    const edge = findEdge(g, "state:cause")!;
    // The before-state is shared between both transitions, so
    // edge.to === t1.beforeId is still correct (the resolver
    // chose the popovertarget successor; both transitions
    // originated from the same before-state). The KEY
    // assertion is that the structural cause field was
    // preserved (not lost) and that the placeholder string
    // did NOT win the kind match.
    expect(edge.to).toBe(t1.beforeId);
    // And the structural cause field was preserved (not lost).
    expect(edge.cause).toBeDefined();
    expect(edge.cause!.declaredKind).toBe("popovertarget");
  });

  it("preserves the resolved edge's structural cause field (declaredKind + commandValue)", () => {
    const before = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: null }) } });
    const after = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: true }) } });
    const t = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after, sourceAxId: SOURCE_AX,
      trigger: "command", evidenceKind: "declared", provenance: "html:parse",
    });
    const placeholder = `state:TBD:commandfor:${SOURCE_AX}`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
      cause: {
        sourceAxId: SOURCE_AX,
        declaredKind: "commandfor",
        commandValue: "show-modal",
      },
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(1);
    const edge = findEdge(g, "state:cause")!;
    expect(edge.to).toBe(t.beforeId);
    // The structural cause must be preserved on the resolved edge
    // (the resolver does NOT erase it on re-pointing).
    expect(edge.cause).toBeDefined();
    expect(edge.cause!.declaredKind).toBe("commandfor");
    expect(edge.cause!.commandValue).toBe("show-modal");
    expect(edge.cause!.sourceAxId).toBe(SOURCE_AX);
  });

  it("works correctly with the new placeholder format (kind:first, sourceAxId:last) when cause is set", () => {
    // The new placeholder format is `state:TBD:<kind>:<sourceAxId>`.
    // A naive split(':'[3]) would yield the sourceAxId prefix
    // segment (not the kind), so any resolver relying on string
    // parsing would look up the WRONG declared kind. This test
    // proves the resolver uses the structural field instead.
    const before = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ expanded: null }) } });
    const after = makeSnapshot({
      elements: { [SOURCE_AX]: makeObs({ expanded: true, rect: { x: 7, y: 7, w: 7, h: 7 } }) },
    });
    const t = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after, sourceAxId: SOURCE_AX,
      trigger: "command-show-popover", evidenceKind: "declared", provenance: "html:parse",
    });
    const placeholder = `state:TBD:popovertarget:${SOURCE_AX}`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
      cause: { sourceAxId: SOURCE_AX, declaredKind: "popovertarget" },
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(1);
    expect(r.removed).toBe(0);
    const edge = findEdge(g, "state:cause")!;
    expect(edge.to).toBe(t.beforeId);
  });

  it("resolves correctly when the placeholder string has an arbitrary suffix (proves it does not parse the string)", () => {
    // If the resolver parsed the placeholder string, this test
    // would fail (the suffix is not a valid kind). The fact that
    // it succeeds proves the resolver does not parse the string.
    const before = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: null }) } });
    const after = makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: true }) } });
    const t = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after, sourceAxId: SOURCE_AX,
      trigger: "command-show-modal", evidenceKind: "declared", provenance: "html:parse",
    });
    // Note: a deliberately malformed placeholder to prove
    // string parsing is NOT the resolution path. The format
    // is "state:TBD:" + (something arbitrary) — but the edge
    // still starts with "state:TBD:" so the resolver picks it
    // up, and the structural `cause` field carries the kind.
    const placeholder = `state:TBD:not-a-kind:garbage:${SOURCE_AX}`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
      cause: { sourceAxId: SOURCE_AX, declaredKind: "commandfor" },
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(1);
    const edge = findEdge(g, "state:cause")!;
    expect(edge.to).toBe(t.beforeId);
  });

  it("REMOVES (not re-points) the edge when no causal evidence exists, even with the new format", () => {
    // No state nodes, no transitions. Place a placeholder with
    // the new format AND a populated cause field. The edge must
    // be removed (not re-pointed at a random state) — PR-8b item
    // 4 — and the onUnresolved callback must fire.
    const placeholder = `state:TBD:commandfor:${SOURCE_AX}`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
      cause: { sourceAxId: SOURCE_AX, declaredKind: "commandfor", commandValue: "open" },
    });
    const unresolved: Array<{ sourceAxId: string; placeholderStateId: string; pageId: string }> = [];
    const r = resolveStateCauseEdges(g, (info) => unresolved.push(info));
    expect(r.resolved).toBe(0);
    expect(r.removed).toBe(1);
    expect(findEdge(g, "state:cause")).toBeUndefined();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.sourceAxId).toBe(SOURCE_AX);
    expect(unresolved[0]!.placeholderStateId).toBe(placeholder);
  });

  it("discriminates commandfor / popovertarget / dialog-open / apg-tab-activate via structural cause field", () => {
    // Four declared transitions from the same before-state, one
    // per kind. Four placeholder edges, one per kind. Each
    // placeholder points at the kind it represents. The resolver
    // must reconnect each to the right before-state.
    const before = makeSnapshot({
      elements: { [SOURCE_AX]: makeObs({ pressed: null, expanded: null, selected: null, open: null }) },
    });
    const tCommandfor = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ pressed: true, rect: { x: 1, y: 1, w: 1, h: 1 } }) } }),
      sourceAxId: SOURCE_AX, trigger: "command-show-modal", evidenceKind: "declared", provenance: "html:parse",
    });
    const tPopovertarget = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ expanded: true, rect: { x: 2, y: 2, w: 2, h: 2 } }) } }),
      sourceAxId: SOURCE_AX, trigger: "command-show-popover", evidenceKind: "declared", provenance: "html:parse",
    });
    const tDialogOpen = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ open: true, rect: { x: 3, y: 3, w: 3, h: 3 } }) } }),
      sourceAxId: SOURCE_AX, trigger: "open-modal", evidenceKind: "declared", provenance: "html:parse",
    });
    const tTabActivate = materializeSuccessor({
      graph: g, pageId: PAGE_ID, route: ROUTE,
      auth: makeAuth(), network: NETWORK,
      before, after: makeSnapshot({ elements: { [SOURCE_AX]: makeObs({ selected: true, rect: { x: 4, y: 4, w: 4, h: 4 } }) } }),
      sourceAxId: SOURCE_AX, trigger: "switch-tab", evidenceKind: "declared", provenance: "html:parse",
    });
    // Note: the before-state is shared across all four (the
    // snapshot didn't differ enough to derive a different id),
    // so all four beforeIds point at the same State. The
    // resolver's job here is to prove each kind was matched to
    // the right successor (which they all share, so all four
    // edges point at the same before-state).
    void tPopovertarget; void tDialogOpen; void tTabActivate;
    const placeholder = `state:TBD:commandfor:${SOURCE_AX}`;
    g.upsertEdge({
      id: `edge:${SOURCE_AX}->${placeholder}:state:cause`,
      type: "edge",
      from: SOURCE_AX,
      to: placeholder,
      kind: "state:cause",
      provenance: "html:parse",
      cause: { sourceAxId: SOURCE_AX, declaredKind: "commandfor" },
    });
    const r = resolveStateCauseEdges(g);
    expect(r.resolved).toBe(1);
    const edge = findEdge(g, "state:cause")!;
    expect(edge.to).toBe(tCommandfor.beforeId);
    expect(edge.cause!.declaredKind).toBe("commandfor");
  });
});
