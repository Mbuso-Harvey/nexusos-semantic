/**
 * VI-03: Occlusion Detection, Visual Clipping Trees, and Spatial Proximity Edges.
 */
import { describe, it, expect } from "vitest";
import {
  computeRectIntersection,
  computeRectArea,
  subtractRect,
  computeUnoccludedArea,
  computeAncestorClipping,
  computeNodeOcclusion,
  computePageOcclusion,
  isCandidateAbove,
} from "../../src/extract-visual/occlusion.js";
import {
  detectSpatialRelations,
  extractSpatialEdges,
  computeSegmentOverlap,
} from "../../src/extract-visual/spatial.js";
import { Graph } from "../../src/graph/graph.js";
import { query } from "../../src/graph/query.js";
import type { VisualNode, AxNode, PageNode } from "../../src/graph/types.js";

function makeVisual(overrides: Partial<VisualNode> & { id: string }): VisualNode {
  return {
    type: "visual-node",
    axId: `ax:${overrides.id}`,
    pageId: "page:https://example.com/",
    rect: { x: 0, y: 0, w: 100, h: 50 },
    computedStyle: {
      display: "block",
      position: "static",
      color: "rgb(0,0,0)",
      backgroundColor: "rgb(255,255,255)",
      fontSize: "16px",
      fontFamily: "sans-serif",
      fontWeight: "400",
      borderRadius: "0px",
      padding: "0px",
      margin: "0px",
    },
    designTokenRefs: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "test" as any,
    ...overrides,
  };
}

describe("VI-03: Geometry Primitives & Rect Subtraction", () => {
  it("computes intersection correctly", () => {
    const r1 = { x: 0, y: 0, w: 100, h: 100 };
    const r2 = { x: 50, y: 50, w: 100, h: 100 };
    const inter = computeRectIntersection(r1, r2);
    expect(inter).toEqual({ x: 50, y: 50, w: 50, h: 50 });

    const nonOverlapping = computeRectIntersection(r1, { x: 200, y: 200, w: 50, h: 50 });
    expect(nonOverlapping).toBeNull();

    const touching = computeRectIntersection(r1, { x: 100, y: 0, w: 50, h: 50 });
    expect(touching).toBeNull();
  });

  it("subtracts non-overlapping rectangle leaving base intact", () => {
    const base = { x: 0, y: 0, w: 100, h: 100 };
    const occluder = { x: 200, y: 200, w: 50, h: 50 };
    const remaining = subtractRect(base, occluder);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual(base);
  });

  it("subtracts completely covering rectangle leaving nothing", () => {
    const base = { x: 10, y: 10, w: 100, h: 100 };
    const occluder = { x: 0, y: 0, w: 200, h: 200 };
    const remaining = subtractRect(base, occluder);
    expect(remaining).toHaveLength(0);
  });

  it("subtracts corner intersection producing 2 non-overlapping fragments", () => {
    const base = { x: 0, y: 0, w: 100, h: 100 }; // area = 10,000
    const occluder = { x: 50, y: 50, w: 100, h: 100 }; // overlap is { x:50, y:50, w:50, h:50 }, area = 2,500
    const remaining = subtractRect(base, occluder);
    const unoccludedArea = remaining.reduce((sum, r) => sum + r.w * r.h, 0);
    expect(unoccludedArea).toBe(7500);
  });

  it("computes unoccluded area with multiple overlapping occluders without double-subtraction", () => {
    const base = { x: 0, y: 0, w: 100, h: 100 }; // area 10,000
    // Occluder 1 covers [0..50, 0..100] (left half, area 5000)
    const occ1 = { x: 0, y: 0, w: 50, h: 100 };
    // Occluder 2 covers [25..75, 0..100] (overlaps occ1 from x=25 to 50)
    const occ2 = { x: 25, y: 0, w: 50, h: 100 };

    // Together they cover x from 0 to 75, so remaining unoccluded is x from 75 to 100 (area 2,500)
    const area = computeUnoccludedArea(base, [occ1, occ2]);
    expect(area).toBe(2500);
  });
});

describe("VI-03: Ancestor Clipping and Viewport Boundaries", () => {
  it("clips element partially outside viewport", () => {
    const node = makeVisual({
      id: "vis:bottom-btn",
      rect: { x: 100, y: 850, w: 200, h: 100 }, // Viewport h = 900, so 50px is clipped off bottom
    });
    const byVisId = new Map([[node.id, node]]);
    const { clippedRect, isOffscreen } = computeAncestorClipping(node, byVisId, { x: 0, y: 0, w: 1440, h: 900 });
    expect(isOffscreen).toBe(false);
    expect(clippedRect).toEqual({ x: 100, y: 850, w: 200, h: 50 });
  });

  it("marks element completely outside viewport as offscreen", () => {
    const node = makeVisual({
      id: "vis:footer-btn",
      rect: { x: 100, y: 1200, w: 200, h: 50 },
    });
    const byVisId = new Map([[node.id, node]]);
    const { clippedRect, isOffscreen } = computeAncestorClipping(node, byVisId, { x: 0, y: 0, w: 1440, h: 900 });
    expect(isOffscreen).toBe(true);
    expect(clippedRect).toBeNull();
  });

  it("clips element by ancestor overflow scroll container", () => {
    const container = makeVisual({
      id: "vis:scroll-container",
      rect: { x: 50, y: 50, w: 300, h: 200 },
      boxModel: {
        boxSizing: "border-box",
        content: { x: 50, y: 50, w: 300, h: 200 },
        paddingBox: { x: 50, y: 50, w: 300, h: 200 },
        borderBox: { x: 50, y: 50, w: 300, h: 200 },
        marginBox: { x: 50, y: 50, w: 300, h: 200 },
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        border: { top: 0, right: 0, bottom: 0, left: 0 },
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      },
      scrollClippingContext: {
        isScrollContainer: true,
        canScrollY: true,
        canScrollX: false,
        scrollWidth: 300,
        scrollHeight: 1000,
        scrollLeft: 0,
        scrollTop: 0,
        overflowX: "hidden",
        overflowY: "scroll",
        isClipped: true,
        clipPath: null,
      },
      computedStyle: {
        display: "block",
        position: "relative",
        overflow: "scroll",
        color: "rgb(0,0,0)",
        backgroundColor: "rgb(255,255,255)",
        fontSize: "16px",
        fontFamily: "sans-serif",
        fontWeight: "400",
        borderRadius: "0px",
        padding: "0px",
        margin: "0px",
      },
    });

    const child = makeVisual({
      id: "vis:scroll-child",
      rect: { x: 50, y: 150, w: 300, h: 200 }, // Extends from y=150 to y=350, but container ends at y=250
      tethers: { parent: container.id, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });

    const byVisId = new Map([
      [container.id, container],
      [child.id, child],
    ]);

    const { clippedRect, isOffscreen } = computeAncestorClipping(child, byVisId, { x: 0, y: 0, w: 1440, h: 900 });
    expect(isOffscreen).toBe(false);
    expect(clippedRect).toEqual({ x: 50, y: 150, w: 300, h: 100 });
  });
});

describe("VI-03: Paint-Order Occlusion Detection", () => {
  it("detects background button fully occluded by modal overlay", () => {
    const button = makeVisual({
      id: "vis:btn",
      rect: { x: 200, y: 200, w: 100, h: 50 },
      stackingContext: { isStackingContext: false, zIndex: 0, reasons: [] },
    });

    const modal = makeVisual({
      id: "vis:modal",
      rect: { x: 0, y: 0, w: 1440, h: 900 },
      computedStyle: {
        display: "block",
        position: "fixed",
        color: "rgb(0,0,0)",
        backgroundColor: "rgba(0,0,0,0.8)",
        fontSize: "16px",
        fontFamily: "sans-serif",
        fontWeight: "400",
        borderRadius: "0px",
        padding: "0px",
        margin: "0px",
      },
      stackingContext: { isStackingContext: true, zIndex: 1000, reasons: ["fixed-position"] },
    });

    const byVisId = new Map([
      [button.id, button],
      [modal.id, modal],
    ]);

    const occ = computeNodeOcclusion(button, [button, modal], byVisId, { w: 1440, h: 900 });
    expect(occ.visibleRatio).toBe(0);
    expect(occ.isOccluded).toBe(true);
    expect(occ.occludedBy).toContain(modal.id);
    expect(occ.visibleArea).toBe(0);
  });

  it("does not treat element as occluded by its own children", () => {
    const card = makeVisual({
      id: "vis:card",
      rect: { x: 100, y: 100, w: 400, h: 300 },
      tethers: { parent: null, children: ["vis:card-btn"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });

    const cardBtn = makeVisual({
      id: "vis:card-btn",
      rect: { x: 150, y: 150, w: 100, h: 40 },
      tethers: { parent: card.id, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
      stackingContext: { isStackingContext: true, zIndex: 1, reasons: [] },
    });

    const byVisId = new Map([
      [card.id, card],
      [cardBtn.id, cardBtn],
    ]);

    const occ = computeNodeOcclusion(card, [card, cardBtn], byVisId, { w: 1440, h: 900 });
    expect(occ.visibleRatio).toBe(1);
    expect(occ.isOccluded).toBe(false);
    expect(occ.occludedBy).toHaveLength(0);
  });

  it("calculates partial occlusion percentage accurately", () => {
    const panel = makeVisual({
      id: "vis:panel",
      rect: { x: 100, y: 100, w: 200, h: 200 }, // area = 40,000
      stackingContext: { isStackingContext: false, zIndex: 0, reasons: [] },
    });

    // Sticky header occluding top 50px of panel: overlap is { x: 100, y: 100, w: 200, h: 50 }, area = 10,000 (25%)
    const stickyHeader = makeVisual({
      id: "vis:sticky-header",
      rect: { x: 0, y: 0, w: 1440, h: 150 },
      computedStyle: {
        display: "block",
        position: "sticky",
        color: "rgb(0,0,0)",
        backgroundColor: "rgb(240,240,240)",
        fontSize: "16px",
        fontFamily: "sans-serif",
        fontWeight: "400",
        borderRadius: "0px",
        padding: "0px",
        margin: "0px",
      },
      stackingContext: { isStackingContext: true, zIndex: 10, reasons: ["sticky-position"] },
    });

    const byVisId = new Map([
      [panel.id, panel],
      [stickyHeader.id, stickyHeader],
    ]);

    const occ = computeNodeOcclusion(panel, [panel, stickyHeader], byVisId, { w: 1440, h: 900 });
    expect(occ.visibleRatio).toBe(0.75);
    expect(occ.isOccluded).toBe(false); // > 0.5 is not occluded
    expect(occ.occludedBy).toContain(stickyHeader.id);
    expect(occ.visibleArea).toBe(30000);
    expect(occ.occludedArea).toBe(10000);
  });
});
describe("VI-03: Spatial Proximity Relations", () => {
  it("detects visual:nested-in when child is contained inside parent container", () => {
    const card = makeVisual({
      id: "vis:card",
      rect: { x: 100, y: 100, w: 400, h: 300 },
    });
    const button = makeVisual({
      id: "vis:btn",
      rect: { x: 120, y: 150, w: 120, h: 40 },
    });

    const rels = detectSpatialRelations(button, card);
    expect(rels).toContainEqual(expect.objectContaining({ kind: "visual:nested-in" }));
  });

  it("detects visual:above and visual:below for vertical siblings with horizontal projection overlap", () => {
    const topCard = makeVisual({
      id: "vis:top-card",
      rect: { x: 100, y: 100, w: 200, h: 80 },
    });
    const bottomCard = makeVisual({
      id: "vis:bottom-card",
      rect: { x: 100, y: 200, w: 200, h: 80 }, // 20px gap between topCard bottom (y=180) and bottomCard top (y=200)
    });

    const relsTopToBottom = detectSpatialRelations(topCard, bottomCard);
    expect(relsTopToBottom).toContainEqual(expect.objectContaining({ kind: "visual:above", distance: 20 }));

    const relsBottomToTop = detectSpatialRelations(bottomCard, topCard);
    expect(relsBottomToTop).toContainEqual(expect.objectContaining({ kind: "visual:below", distance: 20 }));
  });

  it("detects visual:left-of and visual:right-of for horizontal buttons with vertical projection overlap", () => {
    const cancelBtn = makeVisual({
      id: "vis:cancel-btn",
      rect: { x: 100, y: 200, w: 80, h: 40 },
    });
    const submitBtn = makeVisual({
      id: "vis:submit-btn",
      rect: { x: 190, y: 200, w: 80, h: 40 }, // 10px gap between cancelBtn right (x=180) and submitBtn left (x=190)
    });

    const relsLeftToRight = detectSpatialRelations(cancelBtn, submitBtn);
    expect(relsLeftToRight).toContainEqual(expect.objectContaining({ kind: "visual:left-of", distance: 10 }));

    const relsRightToLeft = detectSpatialRelations(submitBtn, cancelBtn);
    expect(relsRightToLeft).toContainEqual(expect.objectContaining({ kind: "visual:right-of", distance: 10 }));
  });

  it("extracts spatial edges and attaches them to Graph", () => {
    const a = makeVisual({ id: "vis:a", rect: { x: 100, y: 100, w: 100, h: 40 } });
    const b = makeVisual({ id: "vis:b", rect: { x: 100, y: 150, w: 100, h: 40 } });

    const edges = extractSpatialEdges([a, b], "test");
    expect(edges.some((e) => e.from === "vis:a" && e.to === "vis:b" && e.kind === "visual:above")).toBe(true);
    expect(edges.some((e) => e.from === "vis:b" && e.to === "vis:a" && e.kind === "visual:below")).toBe(true);
  });
});

describe("VI-03: Graph Queries and Navigation by Occlusion and Spatial Proximity", () => {
  it("queries nodes by isOccluded, minVisibleRatio, and isOffscreen predicates", () => {
    const g = new Graph();
    const page: PageNode = {
      id: "page:https://example.com/",
      type: "page",
      url: "https://example.com/",
      canonicalUrl: "https://example.com/",
      title: "Test Page",
      discoveredVia: [],
      loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "test" as any },
      viewport: { w: 1440, h: 900, dpr: 1 },
      tokensOverride: null,
      screenshotRef: null,
      crawledAt: new Date().toISOString(),
      parentPageId: null,
    };
    g.upsertPage(page);

    const axVisible: AxNode = {
      id: "ax:btn-vis",
      type: "ax-node",
      pageId: page.id,
      role: "button",
      name: "Visible Button",
      nameSource: "contents",
      states: {} as any,
      properties: {} as any,
      apgPattern: null,
      focusable: true,
      visibility: "visible",
      inPageDomOrder: 1,
      parentAxId: null,
      provenance: "test" as any,
    };
    g.upsertAx(axVisible);

    const visVisible = makeVisual({
      id: "vis:btn-vis",
      axId: axVisible.id,
      rect: { x: 100, y: 100, w: 100, h: 40 },
      occlusion: {
        visibleRatio: 1.0,
        isOccluded: false,
        occludedBy: [],
        clippedRect: { x: 100, y: 100, w: 100, h: 40 },
        isOffscreen: false,
        occludedArea: 0,
        visibleArea: 4000,
      },
    });
    g.upsertVisual(visVisible);

    const axOccluded: AxNode = {
      id: "ax:btn-occ",
      type: "ax-node",
      pageId: page.id,
      role: "button",
      name: "Hidden Under Modal",
      nameSource: "contents",
      states: {} as any,
      properties: {} as any,
      apgPattern: null,
      focusable: true,
      visibility: "visible",
      inPageDomOrder: 2,
      parentAxId: null,
      provenance: "test" as any,
    };
    g.upsertAx(axOccluded);

    const visOccluded = makeVisual({
      id: "vis:btn-occ",
      axId: axOccluded.id,
      rect: { x: 100, y: 100, w: 100, h: 40 },
      occlusion: {
        visibleRatio: 0.1,
        isOccluded: true,
        occludedBy: ["vis:modal"],
        clippedRect: { x: 100, y: 100, w: 100, h: 40 },
        isOffscreen: false,
        occludedArea: 3600,
        visibleArea: 400,
      },
    });
    g.upsertVisual(visOccluded);

    const axOffscreen: AxNode = {
      id: "ax:btn-off",
      type: "ax-node",
      pageId: page.id,
      role: "button",
      name: "Offscreen Button",
      nameSource: "contents",
      states: {} as any,
      properties: {} as any,
      apgPattern: null,
      focusable: true,
      visibility: "visible",
      inPageDomOrder: 3,
      parentAxId: null,
      provenance: "test" as any,
    };
    g.upsertAx(axOffscreen);

    const visOffscreen = makeVisual({
      id: "vis:btn-off",
      axId: axOffscreen.id,
      rect: { x: 100, y: 2000, w: 100, h: 40 },
      occlusion: {
        visibleRatio: 0,
        isOccluded: true,
        occludedBy: [],
        clippedRect: null,
        isOffscreen: true,
        occludedArea: 4000,
        visibleArea: 0,
      },
    });
    g.upsertVisual(visOffscreen);

    // Query unoccluded visible buttons
    const visibleQuery = query(g, {
      select: "ax-node",
      where: { role: "button", isOccluded: false, minVisibleRatio: 0.8 },
    });
    expect(visibleQuery.hits).toHaveLength(1);
    expect((visibleQuery.hits[0] as any).node.id).toBe("ax:btn-vis");

    // Query occluded buttons
    const occludedQuery = query(g, {
      select: "ax-node",
      where: { role: "button", isOccluded: true },
    });
    expect(occludedQuery.hits).toHaveLength(2);
    expect(occludedQuery.hits.map((h: any) => h.node.id).sort()).toEqual(["ax:btn-occ", "ax:btn-off"]);

    // Query offscreen elements
    const offscreenQuery = query(g, {
      select: "ax-node",
      where: { isOffscreen: true },
    });
    expect(offscreenQuery.hits).toHaveLength(1);
    expect((offscreenQuery.hits[0] as any).node.id).toBe("ax:btn-off");

    // Graph helper: occludedNodes
    const occNodes = g.occludedNodes(page.id);
    expect(occNodes).toHaveLength(2);

    // Graph helper: spatialNeighbors
    g.upsertEdge({
      id: "edge:vis:btn-vis->vis:btn-occ:visual:above",
      type: "edge",
      from: visVisible.id,
      to: visOccluded.id,
      kind: "visual:above",
      provenance: "test" as any,
      spatial: { distance: 10, overlap: 100 },
    });

    const neighbors = g.spatialNeighbors(visVisible.id, "above");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]!.node.id).toBe(visOccluded.id);
  });
});


