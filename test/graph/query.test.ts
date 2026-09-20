/**
 * Unit tests for the query predicates and the four MCP-shaped tools.
 * Pure data layer — no BiDi.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { query, type WhereClause } from "../../src/graph/query.js";
import { findPath, listTools, prepareAct, explain } from "../../src/graph/tools.js";
import type {
  PageNode, AxNode, VisualNode, Edge, Capability,
} from "../../src/graph/types.js";

function page(id: string, url: string): PageNode {
  return {
    id, type: "page", url, title: url,
    discoveredVia: [], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "declared:t" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: url, crawledAt: new Date(0).toISOString(), parentPageId: null,
  };
}

function ax(id: string, pageId: string, role: AxNode["role"], name: string, opts: Partial<AxNode> = {}): AxNode {
  return {
    id, type: "ax-node", pageId, role, name, nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0,
    parentAxId: null,
    provenance: "aria:t",
    ...opts,
  };
}

function vis(id: string, pageId: string, axId: string, rect: VisualNode["rect"], tethers: VisualNode["tethers"]): VisualNode {
  return {
    id, type: "visual-node", axId, pageId, rect,
    computedStyle: {}, designTokenRefs: [], tethers, provenance: "cdp:t",
  };
}

function edge(id: string, from: string, to: string, kind: Edge["kind"]): Edge {
  return { id, type: "edge", from, to, kind, provenance: "aria:t" };
}

function cap(id: string, pageId: string, axId: string, name: string, security: Capability["security"]): Capability {
  return {
    id, type: "capability", name, description: name,
    inputSchema: {}, outputSchema: {}, source: "webmcp",
    binding: { kind: "ax-node", axId, selector: `[data-cap="${name}"]` },
    security, provenance: "declared:t", pageId,
  };
}

describe("query — basic structural predicates", () => {
  let g: Graph;
  beforeEach(() => {
    g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertPage(page("page:/about", "https://example.com/about"));
    g.upsertAx(ax("ax:btn-signup", "page:/", "button", "Sign up"));
    g.upsertAx(ax("ax:link-about", "page:/", "link", "About us"));
    g.upsertAx(ax("ax:txt-email", "page:/", "textbox", "Email"));
    g.upsertAx(ax("ax:btn-about", "page:/about", "button", "Back home"));
  });

  it("selects ax-nodes by role", () => {
    const r = query(g, { select: "ax-node", where: { role: "button" } });
    expect(r.hits.map(h => h.select === "ax-node" && h.node.id).sort()).toEqual(["ax:btn-about", "ax:btn-signup"]);
  });

  it("filters by name substring", () => {
    const r = query(g, { select: "ax-node", where: { name: "About" } });
    // "About us" link matches; "Back home" button does not.
    expect(r.hits.map(h => h.select === "ax-node" && h.node.id)).toEqual(["ax:link-about"]);
  });

  it("filters by name regex", () => {
    const r = query(g, { select: "ax-node", where: { name: /^Sign/ } });
    expect(r.hits).toHaveLength(1);
  });

  it("filters by pageUrl", () => {
    const r = query(g, { select: "ax-node", where: { pageUrl: "/about" } });
    expect(r.hits).toHaveLength(1);
  });

  it("respects limit and reports truncated", () => {
    const r = query(g, { select: "ax-node", limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.remaining).toBe(-1);
  });
});

describe("query — tether and viewport predicates (load-bearing)", () => {
  let g: Graph;
  beforeEach(() => {
    g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    // ax:root has 3 children buttons + 1 sibling textbox
    g.upsertAx(ax("ax:root", "page:/", "group", "Form"));
    g.upsertAx(ax("ax:btn1", "page:/", "button", "Submit"));
    g.upsertAx(ax("ax:btn2", "page:/", "button", "Cancel"));
    g.upsertAx(ax("ax:btn3", "page:/", "button", "Reset"));
    g.upsertAx(ax("ax:txt", "page:/", "textbox", "Note"));

    g.upsertVisual(vis("vis:root", "page:/", "ax:root", { x: 0, y: 0, w: 800, h: 600 },
      { parent: null, children: ["vis:btn1", "vis:btn2"], siblingsBefore: [], siblingsAfter: [], anchors: [] }));
    g.upsertVisual(vis("vis:btn1", "page:/", "ax:btn1", { x: 10, y: 10, w: 80, h: 30 },
      { parent: "vis:root", children: [], siblingsBefore: [], siblingsAfter: ["vis:btn2"], anchors: [] }));
    g.upsertVisual(vis("vis:btn2", "page:/", "ax:btn2", { x: 100, y: 10, w: 80, h: 30 },
      { parent: "vis:root", children: [], siblingsBefore: ["vis:btn1"], siblingsAfter: [], anchors: [] }));
    g.upsertVisual(vis("vis:btn3", "page:/", "ax:btn3", { x: 200, y: 10, w: 80, h: 30 },
      { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [{ name: "anchored-to", target: "ax:btn1" }] }));
    g.upsertVisual(vis("vis:txt", "page:/", "ax:txt", { x: 10, y: 100, w: 300, h: 30 },
      { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] }));
  });

  it("inTether:children returns children of the target visual", () => {
    const r = query(g, {
      select: "visual-node",
      where: { inTether: { axId: "ax:root", relation: "children" } },
    });
    const ids = r.hits.map(h => h.select === "visual-node" && h.node.id).sort();
    expect(ids).toEqual(["vis:btn1", "vis:btn2"]);
  });

  it("inTether:parent returns the single parent of a given visual", () => {
    const r = query(g, {
      select: "visual-node",
      where: { inTether: { axId: "ax:btn1", relation: "parent" } },
    });
    const ids = r.hits.map(h => h.select === "visual-node" && h.node.id);
    expect(ids).toEqual(["vis:root"]);
  });

  it("inTether:siblings finds siblings that share a parent", () => {
    const r = query(g, {
      select: "visual-node",
      where: { inTether: { axId: "ax:btn1", relation: "siblings" } },
    });
    const ids = r.hits.map(h => h.select === "visual-node" && h.node.id);
    expect(ids).toContain("vis:btn2");
  });

  it("inTether:anchors matches anchored targets", () => {
    const r = query(g, {
      select: "visual-node",
      where: { inTether: { axId: "ax:btn1", relation: "anchors" } },
    });
    const ids = r.hits.map(h => h.select === "visual-node" && h.node.id);
    expect(ids).toEqual(["vis:btn3"]);
  });

  it("withinViewport intersects rects and excludes off-screen visual nodes", () => {
    // Place btn4 far below the viewport
    g.upsertAx(ax("ax:btn4", "page:/", "button", "Far below"));
    g.upsertVisual(vis("vis:btn4", "page:/", "ax:btn4", { x: 0, y: 5000, w: 80, h: 30 },
      { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] }));
    const r = query(g, {
      select: "visual-node",
      where: { withinViewport: { x: 0, y: 0, w: 1280, h: 800 } },
    });
    const ids = r.hits.map(h => h.select === "visual-node" && h.node.id);
    expect(ids).toContain("vis:btn1");
    expect(ids).not.toContain("vis:btn4");
  });
});

describe("query — capability cross-link and traversal", () => {
  let g: Graph;
  beforeEach(() => {
    g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:txt", "page:/", "textbox", "Email"));
    g.upsertAx(ax("ax:btn", "page:/", "button", "Submit"));
    g.upsertEdge(edge("e:1", "ax:txt", "ax:btn", "commandfor"));
    g.upsertCapability(cap("cap:submit", "page:/", "ax:btn", "submit_form", "EXECUTE"));
  });

  it("hasCapability returns ax-nodes whose page has the capability", () => {
    const r = query(g, { select: "ax-node", where: { hasCapability: "submit*" } });
    const ids = r.hits.map(h => h.select === "ax-node" && h.node.id);
    expect(ids).toContain("ax:btn");
  });

  it("reachableFrom finds a 1-hop path", () => {
    const r = query(g, {
      select: "ax-node",
      where: { reachableFrom: { axId: "ax:txt", maxHops: 3 } },
    });
    const ids = r.hits.map(h => h.select === "ax-node" && h.node.id);
    expect(ids).toContain("ax:btn");
  });

  it("reachableFrom with via:[] restricts by edge kind", () => {
    // No edges of kind "aria-controls" in this graph
    const r = query(g, {
      select: "ax-node",
      where: { reachableFrom: { axId: "ax:txt", via: ["aria-controls"], maxHops: 3 } },
    });
    expect(r.hits).toHaveLength(0);
  });
});

describe("query — reachableFrom on a11y:child-of (ED-04 / T6)", () => {
  // The a11y tree is rooted at the document root. Edges go parent -> child.
  // reachableFrom follows edges in their declared direction, so a
  // BFS from a leaf up requires the caller to pass `via: ["a11y:child-of"]`
  // and traverse via the parent (which is only reachable from the leaf via
  // reverse lookup). ED-04 says reachableFrom must work on the a11y tree;
  // the existing BFS handles the forward direction. We add coverage for
  // both forward (parent -> child) and reverse (child -> parent) reach.
  let g: Graph;
  beforeEach(() => {
    g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:root", "page:/", "region", "Doc"));
    g.upsertAx(ax("ax:nav", "page:/", "navigation", "Top nav"));
    g.upsertAx(ax("ax:main", "page:/", "main", "Body"));
    g.upsertAx(ax("ax:a1", "page:/", "link", "Home"));
    g.upsertAx(ax("ax:btn", "page:/", "button", "Go"));
    // parent -> child
    g.upsertEdge(edge("e:rc", "ax:root", "ax:nav", "a11y:child-of"));
    g.upsertEdge(edge("e:rm", "ax:root", "ax:main", "a11y:child-of"));
    g.upsertEdge(edge("e:na1", "ax:nav", "ax:a1", "a11y:child-of"));
    g.upsertEdge(edge("e:mb", "ax:main", "ax:btn", "a11y:child-of"));
  });

  it("forward: BFS from root via a11y:child-of reaches all descendants", () => {
    const r = query(g, {
      select: "ax-node",
      where: { reachableFrom: { axId: "ax:root", via: ["a11y:child-of"], maxHops: 5 } },
    });
    const ids = r.hits.map((h) => h.select === "ax-node" && h.node.id).sort();
    // root's descendants within 5 hops: nav, main, a1, btn.
    expect(ids).toEqual(["ax:a1", "ax:btn", "ax:main", "ax:nav"].sort());
  });

  it("reverse reach: BFS from a leaf via a11y:child-of edges does not see ancestors", () => {
    // Forward BFS follows edges in declared direction (parent -> child).
    // From a1 (a leaf) the only outgoing a11y:child-of edges are... none.
    // So a forward reachableFrom from a1 reaches nothing via a11y:child-of.
    // This documents the existing BFS semantics; the reverse lookup is what
    // `AxNode.parentAxId` and `g.edgesTo(...)` provide, and is what
    // `graph.path { relation: "ancestors" }` exposes.
    const r = query(g, {
      select: "ax-node",
      where: { reachableFrom: { axId: "ax:a1", via: ["a11y:child-of"], maxHops: 5 } },
    });
    expect(r.hits).toEqual([]);
  });

  it("BFS depth limit is honored on the a11y tree", () => {
    const r = query(g, {
      select: "ax-node",
      where: { reachableFrom: { axId: "ax:root", via: ["a11y:child-of"], maxHops: 1 } },
    });
    // depth=1: only direct children of root (nav, main).
    const ids = r.hits.map((h) => h.select === "ax-node" && h.node.id).sort();
    expect(ids).toEqual(["ax:main", "ax:nav"].sort());
  });
});

describe("graph.path", () => {
  it("finds the shortest path between two ax nodes", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:a", "page:/", "button", "A"));
    g.upsertAx(ax("ax:b", "page:/", "textbox", "B"));
    g.upsertAx(ax("ax:c", "page:/", "button", "C"));
    g.upsertEdge(edge("e:1", "ax:a", "ax:b", "aria-controls"));
    g.upsertEdge(edge("e:2", "ax:b", "ax:c", "commandfor"));
    const r = findPath(g, "ax:a", "ax:c");
    expect(r.found).toBe(true);
    expect(r.cost).toBe(2);
    expect(r.hops.map(h => h.via)).toEqual(["aria-controls", "commandfor"]);
  });

  it("returns not-found when no path exists within maxHops", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:a", "page:/", "button", "A"));
    g.upsertAx(ax("ax:b", "page:/", "button", "B"));
    // disconnected
    const r = findPath(g, "ax:a", "ax:b", { maxHops: 5 });
    expect(r.found).toBe(false);
  });

  it("via:[] restricts the BFS to those edge kinds", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:a", "page:/", "button", "A"));
    g.upsertAx(ax("ax:b", "page:/", "textbox", "B"));
    g.upsertAx(ax("ax:c", "page:/", "button", "C"));
    g.upsertEdge(edge("e:1", "ax:a", "ax:b", "aria-controls"));
    g.upsertEdge(edge("e:2", "ax:b", "ax:c", "commandfor"));
    const r = findPath(g, "ax:a", "ax:c", { via: ["aria-controls"] });
    expect(r.found).toBe(false); // can't traverse commandfor
  });
});

describe("graph.tool (capability listing)", () => {
  it("lists capabilities on a page, filtered by name and security tier", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:btn", "page:/", "button", "Submit"));
    g.upsertAx(ax("ax:del", "page:/", "button", "Delete"));
    g.upsertCapability(cap("cap:submit", "page:/", "ax:btn", "submit", "EXECUTE"));
    g.upsertCapability(cap("cap:delete", "page:/", "ax:del", "delete", "CONFIRM"));

    const all = listTools(g, {});
    expect(all.capabilities).toHaveLength(2);

    const exeOnly = listTools(g, { securityAtMost: "EXECUTE" });
    expect(exeOnly.capabilities.map(c => c.id)).toEqual(["cap:submit"]);

    const byName = listTools(g, { name: /sub/i });
    expect(byName.capabilities.map(c => c.id)).toEqual(["cap:submit"]);
  });
});

describe("graph.act (decision layer)", () => {
  it("admits an EXECUTE capability without confirm", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:btn", "page:/", "button", "Submit"));
    g.upsertCapability(cap("cap:submit", "page:/", "ax:btn", "submit", "EXECUTE"));
    const r = prepareAct(g, { capabilityId: "cap:submit", input: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tier).toBe("EXECUTE");
      expect(r.binding.selector).toBe('[data-cap="submit"]');
    }
  });

  it("refuses a CONFIRM capability without confirm:true and returns a preview", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:btn", "page:/", "button", "Delete"));
    g.upsertCapability(cap("cap:del", "page:/", "ax:btn", "delete", "CONFIRM"));
    const r = prepareAct(g, { capabilityId: "cap:del", input: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.decision.requireConfirm).toBe(true);
      expect(r.decision.preview?.tier).toBe("CONFIRM");
    }
  });

  it("admits a CONFIRM capability when confirm:true is passed", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:btn", "page:/", "button", "Delete"));
    g.upsertCapability(cap("cap:del", "page:/", "ax:btn", "delete", "CONFIRM"));
    const r = prepareAct(g, { capabilityId: "cap:del", input: {}, confirm: true });
    expect(r.ok).toBe(true);
  });
});

describe("graph.explain (neighborhood walk)", () => {
  it("returns forward edges, backward edges, page, and same-page capabilities", () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:txt", "page:/", "textbox", "Email"));
    g.upsertAx(ax("ax:btn", "page:/", "button", "Submit"));
    g.upsertEdge(edge("e:1", "ax:txt", "ax:btn", "commandfor"));
    g.upsertCapability(cap("cap:submit", "page:/", "ax:btn", "submit", "EXECUTE"));

    const r = explain(g, { id: "ax:txt", depth: 2 });
    expect(r).not.toBeNull();
    expect(r!.root.id).toBe("ax:txt");
    expect(r!.forward.some(f => f.target.id === "ax:btn")).toBe(true);
    expect(r!.capabilities).toHaveLength(1);
    expect(r!.page?.canonicalUrl).toBe("https://example.com/");
  });

  it("returns null for an unknown id", () => {
    const g = new Graph();
    expect(explain(g, { id: "ax:does-not-exist" })).toBeNull();
  });
});

/**
 * ED-03 / T6: page-level relations live on graph.path (not on the
 * WhereClause DSL). The reachableFrom predicate here is ax-node-scoped
 * and does not see nav:child-of edges.
 */
describe("query — reachableFrom does not see page-level nav:child-of (ED-03 / T6)", () => {
  let g: Graph;
  beforeEach(() => {
    g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertPage({ ...page("page:/about", "https://example.com/about"), parentPageId: "page:/" });
    g.upsertAx(ax("ax:btn", "page:/", "button", "Go"));
    g.upsertAx(ax("ax:link", "page:/about", "link", "Back"));
    g.upsertEdge(edge("e:nav", "page:/", "page:/about", "nav:child-of"));
  });

  it("reachableFrom BFS over ax-edges does not return page-target hits", () => {
    // No ax-edges from ax:btn to anything; reachableFrom from ax:btn
    // over any kind still returns zero hits. The nav:child-of edge
    // has a page id, not an ax id, so it isn't reachable from ax:btn.
    const r = query(g, {
      select: "ax-node",
      where: { reachableFrom: { axId: "ax:btn", maxHops: 5 } },
    });
    expect(r.hits).toEqual([]);
  });

  it("nav:child-of edge is not in the ax-edge BFS (different edge index)", () => {
    // The ax-edge BFS in reachableFrom walks g.edgesFrom(axId). The
    // nav:child-of edge has page ids on both ends, so it isn't reachable
    // from any axId. Document the separation.
    const r = query(g, {
      select: "ax-node",
      where: { reachableFrom: { axId: "ax:btn", via: ["nav:child-of"], maxHops: 5 } },
    });
    expect(r.hits).toEqual([]);
  });
});

/**
 * PR-8: StateNode predicates (stateOnPage, stateAuthKind,
 * stateNetworkEvidence, stateHasOpenDialog, stateHasOpenPopover,
 * stateRoute) and the `select: "state"` dispatch.
 */
describe("query — PR-8 StateNode predicates", () => {
  let g: Graph;
  beforeEach(() => {
    g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertPage(page("page:/admin", "https://example.com/admin"));
    // Three state nodes with different auth/network/route profiles.
    g.upsertState({
      id: "state:anon-closed",
      type: "state",
      pageId: "page:/",
      payload: {
        pageId: "page:/",
        route: "https://example.com/",
        auth: { kind: "anonymous" },
        network: { status: "online", evidence: "static" },
        elements: {},
        // PR-8g T1: State-level focus pointer.
        focusedAxId: null,
        openDialogIds: [],
        openPopoverIds: [],
        expandedRegionAxIds: [],
        viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
        conditionalMarkers: {},
      },
      visualFingerprint: "vp:0",
      authContext: { kind: "anonymous" },
      networkContext: { status: "online", evidence: "static" },
      provenance: "html:parse",
      firstObservedAt: "2026-08-30T00:00:00Z",
      evidence: [{ kind: "declared", sourceAxId: "ax:btn", transitionId: null, at: "2026-08-30T00:00:00Z" }],
    });
    g.upsertState({
      id: "state:admin-open",
      type: "state",
      pageId: "page:/admin",
      payload: {
        pageId: "page:/admin",
        route: "https://example.com/admin",
        auth: { kind: "administrator", principal: "bob", session: "s1" },
        network: { status: "online", evidence: "bidi:network" },
        elements: {},
        // PR-8g T1: State-level focus pointer.
        focusedAxId: null,
        openDialogIds: ["dlg:confirm"],
        openPopoverIds: [],
        expandedRegionAxIds: [],
        viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
        conditionalMarkers: {},
      },
      visualFingerprint: "vp:1",
      authContext: { kind: "administrator", principal: "bob", session: "s1" },
      networkContext: { status: "online", evidence: "bidi:network" },
      provenance: "dom-diff:probe",
      firstObservedAt: "2026-08-30T00:00:01Z",
      evidence: [{ kind: "observed", sourceAxId: "ax:adminbtn", transitionId: null, at: "2026-08-30T00:00:01Z" }],
    });
    g.upsertState({
      id: "state:auth-popover",
      type: "state",
      pageId: "page:/",
      payload: {
        pageId: "page:/",
        route: "https://example.com/",
        auth: { kind: "authenticated", principal: "alice", session: "s2" },
        network: { status: "online", evidence: "page-instrumented" },
        elements: {},
        // PR-8g T1: State-level focus pointer.
        focusedAxId: null,
        openDialogIds: [],
        openPopoverIds: ["popover:notifications"],
        expandedRegionAxIds: [],
        viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
        conditionalMarkers: {},
      },
      visualFingerprint: "vp:2",
      authContext: { kind: "authenticated", principal: "alice", session: "s2" },
      networkContext: { status: "online", evidence: "page-instrumented" },
      provenance: "dom-diff:probe",
      firstObservedAt: "2026-08-30T00:00:02Z",
      evidence: [{ kind: "observed", sourceAxId: "ax:userbtn", transitionId: null, at: "2026-08-30T00:00:02Z" }],
    });
  });

  it("select=state returns all state nodes when no where-clause is given", () => {
    const r = query(g, { select: "state" });
    expect(r.hits.length).toBe(3);
  });

  it("stateOnPage filters by pageId", () => {
    const r = query(g, { select: "state", where: { stateOnPage: "page:/admin" } });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:admin-open");
  });

  it("stateAuthKind filters by AuthContext discriminator", () => {
    const r = query(g, { select: "state", where: { stateAuthKind: "administrator" } });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:admin-open");
  });

  it("stateNetworkEvidence filters by NetworkContext.evidence", () => {
    const r = query(g, { select: "state", where: { stateNetworkEvidence: "bidi:network" } });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:admin-open");
  });

  it("stateHasOpenDialog matches by openDialogIds", () => {
    const r = query(g, { select: "state", where: { stateHasOpenDialog: "dlg:confirm" } });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:admin-open");
  });

  it("stateHasOpenPopover matches by openPopoverIds", () => {
    const r = query(g, { select: "state", where: { stateHasOpenPopover: "popover:notifications" } });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:auth-popover");
  });

  it("stateRoute matches payload.route as substring", () => {
    const r = query(g, { select: "state", where: { stateRoute: "/admin" } });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:admin-open");
  });

  it("stateRoute accepts a RegExp", () => {
    const r = query(g, { select: "state", where: { stateRoute: /\/admin$/ } });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:admin-open");
  });

  it("combines predicates with AND semantics", () => {
    const r = query(g, {
      select: "state",
      where: {
        stateOnPage: "page:/",
        stateAuthKind: "authenticated",
      },
    });
    expect(r.hits.length).toBe(1);
    expect((r.hits[0] as any).node.id).toBe("state:auth-popover");
  });

  it("select=any includes state nodes", () => {
    const r = query(g, { select: "any" });
    // 2 pages + 3 states. No ax-nodes, edges, etc. in this fixture.
    expect(r.hits.length).toBe(5);
    const stateHits = r.hits.filter((h: any) => h.select === "state");
    expect(stateHits.length).toBe(3);
  });
});
