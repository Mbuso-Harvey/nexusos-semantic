/**
 * VI-04: Graph visual patterns querying and query predicates test.
 */
import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { query } from "../../src/graph/query.js";
import type { PageNode, AxNode, VisualNode, ViewportObservation } from "../../src/graph/types.js";
import { DEFAULT_VIEWPORT_PROFILES } from "../../src/graph/types.js";

const PAGE_ID = "page:https://example.com/";

function setupGraph(): Graph {
  const g = new Graph();
  const page: PageNode = {
    id: PAGE_ID,
    type: "page",
    url: "https://example.com/",
    title: "Pattern Test",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "bidi:script.evaluate" },
    viewport: { w: 1440, h: 900, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: "https://example.com/",
    crawledAt: new Date(0).toISOString(),
    parentPageId: null,
  };
  g.upsertPage(page);

  const axFab: AxNode = {
    id: "ax:fab",
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "Add Item",
    nameSource: "attribute",
    states: {
      busy: false, disabled: false, expanded: null, pressed: null,
      selected: null, checked: null, open: null, current: null,
    },
    properties: {
      controls: [], describedBy: [], labelledBy: [], level: null, live: null,
      orientation: null, posInSet: null, setSize: null, valueNow: null,
      valueMin: null, valueMax: null, valueText: null,
    },
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    inPageDomOrder: 1,
    parentAxId: null,
    provenance: "bidi:script.evaluate",
  };
  g.upsertAx(axFab);

  const visFab: VisualNode = {
    id: `vis:${PAGE_ID}:ax:fab`,
    type: "visual-node",
    axId: "ax:fab",
    pageId: PAGE_ID,
    rect: { x: 1350, y: 810, w: 56, h: 56 },
    computedStyle: { position: "fixed", "z-index": "100", cursor: "pointer" },
    designTokenRefs: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.callFunction",
    patterns: [
      { pattern: "fab", confidence: 0.9, reasons: ["fixed", "corner", "interactive"] },
    ],
    primaryPattern: "fab",
  };
  g.upsertVisual(visFab);

  const axHeader: AxNode = {
    id: "ax:hdr",
    type: "ax-node",
    pageId: PAGE_ID,
    role: "banner",
    name: "Site Header",
    nameSource: "attribute",
    states: {
      busy: false, disabled: false, expanded: null, pressed: null,
      selected: null, checked: null, open: null, current: null,
    },
    properties: {
      controls: [], describedBy: [], labelledBy: [], level: null, live: null,
      orientation: null, posInSet: null, setSize: null, valueNow: null,
      valueMin: null, valueMax: null, valueText: null,
    },
    apgPattern: null,
    focusable: false,
    visibility: "visible",
    inPageDomOrder: 0,
    parentAxId: null,
    provenance: "bidi:script.evaluate",
  };
  g.upsertAx(axHeader);

  const visHeader: VisualNode = {
    id: `vis:${PAGE_ID}:ax:hdr`,
    type: "visual-node",
    axId: "ax:hdr",
    pageId: PAGE_ID,
    rect: { x: 0, y: 0, w: 1440, h: 70 },
    computedStyle: { position: "sticky", top: "0px" },
    designTokenRefs: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.callFunction",
    patterns: [
      { pattern: "sticky-header", confidence: 0.95, reasons: ["sticky top"] },
    ],
    primaryPattern: "sticky-header",
  };
  g.upsertVisual(visHeader);

  const obsDesktop: ViewportObservation = {
    viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
    rect: { x: 0, y: 0, w: 1440, h: 70 },
    visibility: "visible",
    computedStyle: { display: "flex", "flex-direction": "row" },
    crawledAt: new Date().toISOString(),
  };
  const obsMobile: ViewportObservation = {
    viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
    rect: { x: 0, y: 0, w: 390, h: 60 },
    visibility: "visible",
    computedStyle: { display: "flex", "flex-direction": "column" },
    crawledAt: new Date().toISOString(),
  };
  g.addViewportObservation("ax:hdr", obsDesktop);
  g.addViewportObservation("ax:hdr", obsMobile);

  return g;
}

describe("VI-04: Graph visual patterns & layout mutations", () => {
  it("graph.visualPatterns filters by pattern kind and confidence", () => {
    const g = setupGraph();
    const fabs = g.visualPatterns(PAGE_ID, "fab");
    expect(fabs).toHaveLength(1);
    expect(fabs[0]!.axId).toBe("ax:fab");

    const headers = g.visualPatterns(PAGE_ID, "sticky-header");
    expect(headers).toHaveLength(1);
    expect(headers[0]!.axId).toBe("ax:hdr");

    const footers = g.visualPatterns(PAGE_ID, "sticky-footer");
    expect(footers).toHaveLength(0);
  });

  it("graph.queryPageLayoutMutations returns classified mutations", () => {
    const g = setupGraph();
    const result = g.queryPageLayoutMutations(PAGE_ID, "desktop", "mobile");
    expect(result).not.toBeNull();
    expect(result!.pageId).toBe(PAGE_ID);
    expect(result!.summary.totalElements).toBeGreaterThanOrEqual(1);
    expect(result!.summary.reflowCount).toBeGreaterThanOrEqual(1);
    expect(result!.breakpointDescription).toContain("desktop(1440px) to mobile(390px)");
  });

  it("query() matches visual patterns via where predicates", () => {
    const g = setupGraph();

    // Select ax-nodes with isFab: true
    const fabAxRes = query(g, {
      select: "ax-node",
      where: { isFab: true },
    });
    expect(fabAxRes.hits).toHaveLength(1);
    expect(fabAxRes.hits[0]!.node.id).toBe("ax:fab");

    // Select ax-nodes with isStickyHeader: true
    const headerAxRes = query(g, {
      select: "ax-node",
      where: { isStickyHeader: true },
    });
    expect(headerAxRes.hits).toHaveLength(1);
    expect(headerAxRes.hits[0]!.node.id).toBe("ax:hdr");

    // Select visual-nodes with visualPattern: "fab"
    const fabVisRes = query(g, {
      select: "visual-node",
      where: { visualPattern: "fab" },
    });
    expect(fabVisRes.hits).toHaveLength(1);
    expect(fabVisRes.hits[0]!.node.id).toBe(`vis:${PAGE_ID}:ax:fab`);

    // Select visual-nodes with hasPattern: true
    const anyPatternVisRes = query(g, {
      select: "visual-node",
      where: { hasPattern: true },
    });
    expect(anyPatternVisRes.hits).toHaveLength(2);
  });
});
