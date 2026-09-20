/**
 * Unit tests for the in-memory Graph class — the substrate the extractors
 * write to and the query layer reads from. No BiDi required.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import type {
  PageNode, AxNode, VisualNode, Edge, Capability, Transition,
} from "../../src/graph/types.js";

function makePage(id: string, url: string): PageNode {
  return {
    id,
    type: "page",
    url,
    title: url,
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "declared:test" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: url,
    crawledAt: new Date(0).toISOString(), parentPageId: null,
  };
}

function makeAx(id: string, pageId: string, role: AxNode["role"], name: string, opts: Partial<AxNode> = {}): AxNode {
  return {
    id,
    type: "ax-node",
    pageId,
    role,
    name,
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: true, visibility: "visible", inPageDomOrder: 0,
    parentAxId: null,
    provenance: "aria:test",
    ...opts,
  };
}

function makeVis(id: string, pageId: string, axId: string, rect: VisualNode["rect"], tethers: VisualNode["tethers"]): VisualNode {
  return {
    id,
    type: "visual-node",
    axId,
    pageId,
    rect,
    computedStyle: {},
    designTokenRefs: [],
    tethers,
    provenance: "cdp:test",
  };
}

function makeEdge(id: string, from: string, to: string, kind: Edge["kind"]): Edge {
  return { id, type: "edge", from, to, kind, provenance: "aria:test" };
}

function makeCap(id: string, pageId: string, axId: string, name: string, security: Capability["security"]): Capability {
  return {
    id, type: "capability", name,
    description: name,
    inputSchema: {}, outputSchema: {},
    source: "webmcp",
    binding: { kind: "ax-node", axId, selector: `[data-cap="${name}"]` },
    security, provenance: "declared:test", pageId,
  };
}

function makeTrans(id: string, fromAxId: string, toAxIds: string[]): Transition {
  return {
    id, type: "transition", kind: "observed", trigger: "click",
    fromAxId, toAxIds,
    beforeSnapshot: "snapshot:0", afterSnapshot: "snapshot:1",
    apgPattern: null, preconditions: [], provenance: "dom-diff:test",
  };
}

describe("Graph — primary stores", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); });

  it("upserts and retrieves pages, ax, visual, edges, capabilities, transitions", () => {
    g.upsertPage(makePage("page:/", "https://example.com/"));
    g.upsertAx(makeAx("ax:btn", "page:/", "button", "Sign up"));
    g.upsertVisual(makeVis("vis:btn", "page:/", "ax:btn", { x: 10, y: 10, w: 100, h: 40 }, { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] }));
    g.upsertEdge(makeEdge("edge:a->b", "ax:a", "ax:b", "aria-controls"));
    g.upsertCapability(makeCap("cap:sign", "page:/", "ax:btn", "sign_up", "EXECUTE"));
    g.upsertTransition(makeTrans("trans:1", "ax:btn", ["ax:next"]));

    expect(g.pageCount).toBe(1);
    expect(g.axCount).toBe(1);
    expect(g.visualCount).toBe(1);
    expect(g.edgeCount).toBe(1);
    expect(g.capabilityCount).toBe(1);
    expect(g.transitionCount).toBe(1);

    expect(g.getPage("page:/")?.canonicalUrl).toBe("https://example.com/");
    expect(g.getAx("ax:btn")?.name).toBe("Sign up");
    expect(g.visualByAx("ax:btn")?.id).toBe("vis:btn");
    expect(g.getEdge("edge:a->b")?.kind).toBe("aria-controls");
    expect(g.getCapability("cap:sign")?.security).toBe("EXECUTE");
    expect(g.getTransition("trans:1")?.toAxIds).toEqual(["ax:next"]);
  });

  it("maintains axByPage and axByRole indexes on upsert and re-upsert", () => {
    g.upsertPage(makePage("page:/a", "https://a/"));
    g.upsertPage(makePage("page:/b", "https://b/"));
    g.upsertAx(makeAx("ax:1", "page:/a", "button", "A"));
    g.upsertAx(makeAx("ax:2", "page:/a", "link", "B"));
    g.upsertAx(makeAx("ax:3", "page:/b", "button", "C"));
    expect(g.axByPage("page:/a")).toHaveLength(2);
    expect(g.axByPage("page:/b")).toHaveLength(1);
    expect(g.axByRole("button")).toHaveLength(2);
    expect(g.axByRole("link")).toHaveLength(1);

    // re-upsert with new pageId should move the index entry
    g.upsertAx(makeAx("ax:1", "page:/b", "button", "A"));
    expect(g.axByPage("page:/a")).toHaveLength(1);
    expect(g.axByPage("page:/b")).toHaveLength(2);
  });

  it("serializes to a GraphDocument with version 1.0.0 and the right counts", () => {
    g.upsertPage(makePage("page:/", "https://example.com/"));
    g.upsertToken("color.bg", { $value: "#fff", $type: "color" });
    g.upsertToken("color.bg.subtle", { $value: "#f5f5f5", $type: "color" });
    const doc = g.toDocument({
      rootUrl: "https://example.com/",
      startedAt: "t0", finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
      pages: 1, tokens: 2,
    });
    expect(doc.version).toBe("1.0.0");
    expect(doc.crawl.pages).toBe(1);
    expect(doc.designTokens.color.bg.$value).toBe("#fff");
    expect(doc.designTokens.color.bg.subtle.$value).toBe("#f5f5f5");
  });

  it("preserves edge provenance (multiple edges from same pair, different kinds)", () => {
    g.upsertEdge(makeEdge("edge:1", "ax:a", "ax:b", "aria-controls"));
    g.upsertEdge(makeEdge("edge:2", "ax:a", "ax:b", "aria-describedBy"));
    expect(g.edgesFrom("ax:a")).toHaveLength(2);
  });

  it("caches bindings for re-resolve", () => {
    g.upsertPage(makePage("page:/", "https://example.com/"));
    g.setBinding("page:/", "[data-cap=sign_up]", 42);
    expect(g.getBinding("page:/", "[data-cap=sign_up]")).toBe(42);
  });
});

// PR-8a: NavElement storage + index. Mirrors the axByPage/axByRole
// pattern. Used by graph.path nav-level relations (T6) and
// graph.query nav-element select (T7).
describe("Graph — NavElement (PR-8a)", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); });

  it("upserts, retrieves, and counts NavElements by id", () => {
    const n = (overrides: Partial<{ id: string; pageId: string; kind: any; containerAxId: string }>) => ({
      id: overrides.id ?? "nav:1",
      type: "nav-element" as const,
      pageId: overrides.pageId ?? "page:/",
      kind: overrides.kind ?? "menu" as const,
      inPageDomOrder: 0,
      containerAxId: overrides.containerAxId ?? "ax:c",
      memberAxIds: [],
      activeMemberAxId: null,
      name: null,
      provenance: "html:parse" as const,
    });
    g.upsertNavElement(n({ id: "nav:a", pageId: "page:/a" }));
    g.upsertNavElement(n({ id: "nav:b", pageId: "page:/a" }));
    g.upsertNavElement(n({ id: "nav:c", pageId: "page:/b", kind: "tablist" }));
    expect(g.navElementCount).toBe(3);
    expect(g.getNavElement("nav:b")?.pageId).toBe("page:/a");
    expect(g.getNavElement("nav:c")?.kind).toBe("tablist");
  });

  it("maintains the navByPage secondary index", () => {
    const n = (id: string, pageId: string) => ({
      id, type: "nav-element" as const, pageId,
      kind: "menu" as const, inPageDomOrder: 0, containerAxId: "ax:c",
      memberAxIds: [], activeMemberAxId: null, name: null, provenance: "html:parse" as const,
    });
    g.upsertNavElement(n("nav:1", "page:/a"));
    g.upsertNavElement(n("nav:2", "page:/a"));
    g.upsertNavElement(n("nav:3", "page:/b"));
    expect(g.navElementsByPage("page:/a")).toHaveLength(2);
    expect(g.navElementsByPage("page:/b")).toHaveLength(1);
    expect(g.navElementsByPage("page:/missing")).toEqual([]);
  });

  it("upserting the same id overwrites the prior entry (idempotent)", () => {
    const n = (id: string, name: string) => ({
      id, type: "nav-element" as const, pageId: "page:/",
      kind: "menu" as const, inPageDomOrder: 0, containerAxId: "ax:c",
      memberAxIds: [], activeMemberAxId: null, name,
      provenance: "html:parse" as const,
    });
    g.upsertNavElement(n("nav:1", "first"));
    g.upsertNavElement(n("nav:1", "second"));
    expect(g.navElementCount).toBe(1);
    expect(g.getNavElement("nav:1")?.name).toBe("second");
  });

  it("toDocument includes navElements in the document payload", () => {
    const n = {
      id: "nav:1", type: "nav-element" as const, pageId: "page:/",
      kind: "menu" as const, inPageDomOrder: 0, containerAxId: "ax:c",
      memberAxIds: [], activeMemberAxId: null, name: "User menu",
      provenance: "html:parse" as const,
    };
    g.upsertPage(makePage("page:/", "https://example.com/"));
    g.upsertNavElement(n);
    const doc = g.toDocument({
      rootUrl: "https://example.com/", startedAt: "t", finishedAt: "t",
      browser: { engine: "firefox", version: "154" }, pages: 1, tokens: 0,
    });
    expect(doc.navElements).toHaveLength(1);
    expect(doc.navElements[0]?.name).toBe("User menu");
  });

describe("Graph VI-05 Visual Regression & Token Intelligence", () => {
  it("diffVisualRegression compares two graphs for visual regressions", () => {
    const gBase = new Graph();
    const gCand = new Graph();

    gBase.upsertVisual({
      id: "vis:page:/:ax:1",
      type: "visual-node",
      axId: "ax:1",
      pageId: "page:/",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      computedStyle: { display: "block" },
      designTokenRefs: [],
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
      provenance: "bidi:script.callFunction",
      viewport: { name: "desktop", w: 1440, h: 900, dpr: 1 },
    });

    gCand.upsertVisual({
      id: "vis:page:/:ax:1",
      type: "visual-node",
      axId: "ax:1",
      pageId: "page:/",
      rect: { x: 0, y: 150, w: 100, h: 50 }, // Shifted down
      computedStyle: { display: "block" },
      designTokenRefs: [],
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
      provenance: "bidi:script.callFunction",
      viewport: { name: "desktop", w: 1440, h: 900, dpr: 1 },
    });

    const report = gCand.diffVisualRegression(gBase, "page:/");
    expect(report.pageId).toBe("page:/");
    expect(report.regressedNodesCount).toBe(1);
    expect(report.cumulativeLayoutShift).toBeGreaterThan(0);
  });

  it("lintTokenDrift identifies deviations and exportDtcgTokens exports bundle", () => {
    const g = new Graph();
    g.upsertToken("color.brand", {
      $value: "#0066cc",
      $type: "color",
    });

    g.upsertVisual({
      id: "vis:page:/:ax:btn",
      type: "visual-node",
      axId: "ax:btn",
      pageId: "page:/",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      computedStyle: {
        backgroundColor: "rgb(0, 105, 206)", // Slight deviation
      },
      designTokenRefs: [],
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
      provenance: "bidi:script.callFunction",
      viewport: { name: "desktop", w: 1440, h: 900, dpr: 1 },
    });

    const drifts = g.lintTokenDrift("page:/");
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.suggestedToken).toBe("color.brand");

    const bundle = g.exportDtcgTokens();
    expect(bundle.version).toBe("1.0.0");
    expect(bundle.tokens.color.brand.$value).toBe("#0066cc");
  });
});

});
