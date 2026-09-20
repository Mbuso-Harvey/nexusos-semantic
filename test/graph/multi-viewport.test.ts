/**
 * VI-01: Multi-viewport visual snapshot capture unit tests.
 *
 * Verifies:
 *   1. ViewportProfile definitions and DEFAULT_VIEWPORT_PROFILES matrix.
 *   2. Graph multi-viewport observation recording, index lookups, and identity preservation.
 *   3. `queryViewportDiff` computation: offsets, dimensions, percent changes, visibility transitions, and style deltas.
 *   4. Graph query predicates: `where.viewport` and `where.visualHiddenAtViewport`.
 *   5. Multi-viewport extractor flow cycling across profiles without overwriting element identities.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { query } from "../../src/graph/query.js";
import {
  DEFAULT_VIEWPORT_PROFILES,
  type ViewportProfile,
  type ViewportObservation,
  type VisualNode,
  type AxNode,
  type PageNode,
} from "../../src/graph/types.js";
import { visualExtractor } from "../../src/extract-visual/visual.js";
import { DEFAULT_BUDGET } from "../../src/crawler/orchestrator.js";

function makePage(id = "page:/", url = "https://example.com/"): PageNode {
  return {
    id,
    type: "page",
    url,
    title: "Example Test Page",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
    viewport: { w: 1440, h: 900, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: url,
    crawledAt: new Date(0).toISOString(),
    parentPageId: null,
  };
}

function makeAx(id: string, pageId: string, role: AxNode["role"], name: string): AxNode {
  return {
    id,
    type: "ax-node",
    pageId,
    role,
    name,
    nameSource: "aria-label",
    states: {
      expanded: null,
      disabled: null,
      pressed: null,
      selected: null,
      checked: null,
      busy: null,
      open: null,
      current: null,
    },
    properties: {
      controls: [],
      describedBy: [],
      labelledBy: [],
      level: null,
      live: null,
      orientation: null,
      posInSet: null,
      setSize: null,
      valueNow: null,
      valueMin: null,
      valueMax: null,
      valueText: null,
    },
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    inPageDomOrder: 0,
    parentAxId: null,
    provenance: "aria:t",
  };
}

describe("VI-01: Multi-viewport visual snapshot capture", () => {
  describe("ViewportProfile schema & DEFAULT_VIEWPORT_PROFILES matrix", () => {
    it("defines explicit canonical desktop, laptop, tablet, and mobile profiles", () => {
      expect(DEFAULT_VIEWPORT_PROFILES.desktop).toEqual({
        name: "desktop",
        w: 1440,
        h: 900,
        dpr: 1,
      });
      expect(DEFAULT_VIEWPORT_PROFILES.laptop).toEqual({
        name: "laptop",
        w: 1280,
        h: 800,
        dpr: 1,
      });
      expect(DEFAULT_VIEWPORT_PROFILES.tablet).toEqual({
        name: "tablet",
        w: 768,
        h: 1024,
        dpr: 2,
        hasTouch: true,
      });
      expect(DEFAULT_VIEWPORT_PROFILES.mobile).toEqual({
        name: "mobile",
        w: 390,
        h: 844,
        dpr: 3,
        isMobile: true,
        hasTouch: true,
      });
    });
  });

  describe("Graph observation storage & identity preservation", () => {
    let g: Graph;

    beforeEach(() => {
      g = new Graph();
      g.upsertPage(makePage());
      g.upsertAx(makeAx("ax:nav", "page:/", "navigation", "Main Navigation"));
      g.upsertAx(makeAx("ax:menu-btn", "page:/", "button", "Toggle Menu"));
    });

    it("anchors observations by axId and preserves identity across viewports", () => {
      const desktopObs: ViewportObservation = {
        viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
        rect: { x: 0, y: 0, w: 1200, h: 60 },
        computedStyle: { display: "flex", "flex-direction": "row" },
        visibility: "visible",
        crawledAt: new Date(1000).toISOString(),
      };

      const mobileObs: ViewportObservation = {
        viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
        rect: { x: 0, y: 0, w: 390, h: 0 },
        computedStyle: { display: "none", "flex-direction": "column" },
        visibility: "hidden",
        crawledAt: new Date(2000).toISOString(),
      };

      const visNode: VisualNode = {
        id: "vis:page:/:ax:nav",
        type: "visual-node",
        axId: "ax:nav",
        pageId: "page:/",
        rect: desktopObs.rect,
        computedStyle: desktopObs.computedStyle,
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:t",
        viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
        viewportObservations: {
          desktop: desktopObs,
        },
      };
      g.upsertVisual(visNode);

      g.addViewportObservation("ax:nav", mobileObs);

      const ax = g.getAx("ax:nav");
      expect(ax).toBeDefined();
      expect(ax?.id).toBe("ax:nav");

      const observations = g.visualObservationsByAx("ax:nav");
      expect(observations).toHaveLength(2);
      expect(observations.map((o) => o.viewport.name)).toEqual(["desktop", "mobile"]);

      const byNameDesktop = g.visualByAxAndViewport("ax:nav", "desktop");
      expect(byNameDesktop).toBeDefined();
      expect((byNameDesktop as ViewportObservation).rect.w).toBe(1200);

      const byNameMobile = g.visualByAxAndViewport("ax:nav", "mobile");
      expect(byNameMobile).toBeDefined();
      expect((byNameMobile as ViewportObservation).visibility).toBe("hidden");

      const byWidthMobile = g.visualByAxAndViewport("ax:nav", 390);
      expect(byWidthMobile).toBeDefined();
      expect((byWidthMobile as ViewportObservation).viewport.name).toBe("mobile");
    });
  });
  describe("queryViewportDiff", () => {
    let g: Graph;

    beforeEach(() => {
      g = new Graph();
      g.upsertPage(makePage());
      g.upsertAx(makeAx("ax:card", "page:/", "article", "Product Card"));
      g.upsertAx(makeAx("ax:sidebar", "page:/", "complementary", "Sidebar"));

      g.upsertVisual({
        id: "vis:card",
        type: "visual-node",
        axId: "ax:card",
        pageId: "page:/",
        rect: { x: 100, y: 150, w: 400, h: 300 },
        computedStyle: { display: "block", position: "relative", "font-size": "16px" },
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:t",
        viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
        viewportObservations: {
          desktop: {
            viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
            rect: { x: 100, y: 150, w: 400, h: 300 },
            computedStyle: { display: "block", position: "relative", "font-size": "16px" },
            visibility: "visible",
            crawledAt: new Date(1000).toISOString(),
          },
          mobile: {
            viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
            rect: { x: 10, y: 200, w: 370, h: 250 },
            computedStyle: { display: "block", position: "relative", "font-size": "14px" },
            visibility: "visible",
            crawledAt: new Date(2000).toISOString(),
          },
        },
      });

      g.upsertVisual({
        id: "vis:sidebar",
        type: "visual-node",
        axId: "ax:sidebar",
        pageId: "page:/",
        rect: { x: 0, y: 60, w: 280, h: 840 },
        computedStyle: { display: "block", position: "fixed" },
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:t",
        viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
        viewportObservations: {
          desktop: {
            viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
            rect: { x: 0, y: 60, w: 280, h: 840 },
            computedStyle: { display: "block", position: "fixed" },
            visibility: "visible",
            crawledAt: new Date(1000).toISOString(),
          },
          mobile: {
            viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
            rect: { x: 0, y: 0, w: 0, h: 0 },
            computedStyle: { display: "none", position: "fixed" },
            visibility: "hidden",
            crawledAt: new Date(2000).toISOString(),
          },
        },
      });
    });

    it("calculates geometric offsets, dimension changes, and style deltas", () => {
      const diff = g.queryViewportDiff("ax:card", "desktop", "mobile");
      expect(diff).not.toBeNull();
      if (!diff) return;

      expect(diff.axId).toBe("ax:card");
      expect(diff.fromViewport.name).toBe("desktop");
      expect(diff.toViewport.name).toBe("mobile");

      // Offsets
      expect(diff.rectDelta.dx).toBe(-90);
      expect(diff.rectDelta.dy).toBe(50);

      // Dimensions
      expect(diff.rectDelta.dw).toBe(-30);
      expect(diff.rectDelta.dh).toBe(-50);
      expect(diff.rectDelta.widthPercentChange).toBeCloseTo(-7.5);
      expect(diff.rectDelta.heightPercentChange).toBeCloseTo(-16.666, 1);

      // Visibility
      expect(diff.visibilityChange.changed).toBe(false);
      expect(diff.visibilityChange.from).toBe("visible");
      expect(diff.visibilityChange.to).toBe("visible");

      // Styles
      expect(diff.styleDeltas["font-size"]).toEqual({ from: "16px", to: "14px" });

      // Summary synthesis
      expect(diff.summary).toContain("resized from 400×300 at desktop(1440px) to 370×250 at mobile(390px)");
      expect(diff.summary).toContain("offset shifted by dx=-90px, dy=+50px");
      expect(diff.summary).toContain("font-size: 16px → 14px");
    });

    it("detects visibility changes when an element is hidden on mobile", () => {
      const diff = g.queryViewportDiff("ax:sidebar", "desktop", "mobile");
      expect(diff).not.toBeNull();
      if (!diff) return;

      expect(diff.visibilityChange.changed).toBe(true);
      expect(diff.visibilityChange.from).toBe("visible");
      expect(diff.visibilityChange.to).toBe("hidden");
      expect(diff.summary).toContain("Visibility changed from visible to hidden");
      expect(diff.styleDeltas["display"]).toEqual({ from: "block", to: "none" });
    });

    it("supports querying by numeric widths", () => {
      const diff = g.queryViewportDiff("ax:card", 1440, 390);
      expect(diff).not.toBeNull();
      expect(diff?.fromViewport.w).toBe(1440);
      expect(diff?.toViewport.w).toBe(390);
      expect(diff?.rectDelta.dw).toBe(-30);
    });

    it("returns null cleanly when observations are missing", () => {
      expect(g.queryViewportDiff("ax:nonexistent", "desktop", "mobile")).toBeNull();
      expect(g.queryViewportDiff("ax:card", "desktop", "tablet")).toBeNull();
    });
  });

  describe("Graph query predicates: where.viewport and where.visualHiddenAtViewport", () => {
    let g: Graph;

    beforeEach(() => {
      g = new Graph();
      g.upsertPage(makePage());

      g.upsertAx(makeAx("ax:desktop-only-menu", "page:/", "menu", "Desktop Navigation Menu"));
      g.upsertAx(makeAx("ax:mobile-hamburger", "page:/", "button", "Hamburger Menu Button"));
      g.upsertAx(makeAx("ax:footer", "page:/", "contentinfo", "Site Footer"));

      // Desktop-only menu: visible on desktop, display:none on mobile
      g.upsertVisual({
        id: "vis:desktop-only-menu",
        type: "visual-node",
        axId: "ax:desktop-only-menu",
        pageId: "page:/",
        rect: { x: 200, y: 0, w: 800, h: 50 },
        computedStyle: { display: "flex", visibility: "visible" },
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:t",
        viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
        viewportObservations: {
          desktop: {
            viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
            rect: { x: 200, y: 0, w: 800, h: 50 },
            computedStyle: { display: "flex", visibility: "visible" },
            visibility: "visible",
            crawledAt: new Date(1000).toISOString(),
          },
          mobile: {
            viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
            rect: { x: 0, y: 0, w: 0, h: 0 },
            computedStyle: { display: "none", visibility: "hidden" },
            visibility: "hidden",
            crawledAt: new Date(2000).toISOString(),
          },
        },
      });

      // Mobile hamburger: hidden on desktop, visible on mobile
      g.upsertVisual({
        id: "vis:mobile-hamburger",
        type: "visual-node",
        axId: "ax:mobile-hamburger",
        pageId: "page:/",
        rect: { x: 0, y: 0, w: 0, h: 0 },
        computedStyle: { display: "none", visibility: "hidden" },
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:t",
        viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
        viewportObservations: {
          desktop: {
            viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
            rect: { x: 0, y: 0, w: 0, h: 0 },
            computedStyle: { display: "none", visibility: "hidden" },
            visibility: "hidden",
            crawledAt: new Date(1000).toISOString(),
          },
          mobile: {
            viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
            rect: { x: 10, y: 10, w: 44, h: 44 },
            computedStyle: { display: "block", visibility: "visible" },
            visibility: "visible",
            crawledAt: new Date(2000).toISOString(),
          },
        },
      });

      // Footer: visible everywhere
      g.upsertVisual({
        id: "vis:footer",
        type: "visual-node",
        axId: "ax:footer",
        pageId: "page:/",
        rect: { x: 0, y: 800, w: 1440, h: 100 },
        computedStyle: { display: "block", visibility: "visible" },
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:t",
        viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
        viewportObservations: {
          desktop: {
            viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
            rect: { x: 0, y: 800, w: 1440, h: 100 },
            computedStyle: { display: "block", visibility: "visible" },
            visibility: "visible",
            crawledAt: new Date(1000).toISOString(),
          },
          mobile: {
            viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
            rect: { x: 0, y: 800, w: 390, h: 120 },
            computedStyle: { display: "block", visibility: "visible" },
            visibility: "visible",
            crawledAt: new Date(2000).toISOString(),
          },
        },
      });
    });

    it("filters visual nodes by target viewport name", () => {
      const res = query(g, { select: "visual-node", where: { viewport: "mobile" } });
      expect(res.hits).toHaveLength(3);
    });

    it("filters visual nodes by viewport dimensions", () => {
      const res = query(g, { select: "visual-node", where: { viewport: { w: 390 } } });
      expect(res.hits).toHaveLength(3);
    });

    it("selects visual nodes hidden at mobile viewport (visualHiddenAtViewport)", () => {
      const res = query(g, {
        select: "visual-node",
        where: { visualHiddenAtViewport: "mobile" },
      });
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]!.node.id).toBe("vis:desktop-only-menu");
    });

    it("selects accessible nodes hidden at mobile viewport (ax-node query)", () => {
      const res = query(g, {
        select: "ax-node",
        where: { visualHiddenAtViewport: "mobile" },
      });
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]!.node.id).toBe("ax:desktop-only-menu");
    });

    it("combines visualHiddenAtViewport with role filters", () => {
      const res = query(g, {
        select: "ax-node",
        where: { role: "menu", visualHiddenAtViewport: "mobile" },
      });
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]!.node.id).toBe("ax:desktop-only-menu");

      const noMatch = query(g, {
        select: "ax-node",
        where: { role: "button", visualHiddenAtViewport: "mobile" },
      });
      expect(noMatch.hits).toHaveLength(0);
    });
  });

  describe("Multi-viewport extractor simulation", () => {
    it("cycles across configured viewports and registers observations without loss of identity", async () => {
      const g = new Graph();
      const pageNode = makePage();
      g.upsertPage(pageNode);
      g.upsertAx(makeAx("ax:banner", pageNode.id, "banner", "Header Banner"));

      const setViewportCalls: ViewportProfile[] = [];
      const mockPage: any = {
        target: { context: "ctx-1" },
        setViewport: vi.fn().mockImplementation(async (vp: ViewportProfile) => {
          setViewportCalls.push(vp);
        }),
        script: {
          callFunction: vi.fn().mockImplementation(async (_target: any, _fn: any) => {
            const currentVp = setViewportCalls[setViewportCalls.length - 1] ?? DEFAULT_VIEWPORT_PROFILES.desktop;
            if (currentVp.name === "mobile") {
              return {
                elements: [
                  {
                    axId: "ax:banner",
                    rect: { x: 0, y: 0, w: 390, h: 80 },
                    computedStyle: { display: "block", position: "relative" },
                  },
                ],
              };
            }
            // Desktop baseline
            return {
              elements: [
                {
                  axId: "ax:banner",
                  rect: { x: 0, y: 0, w: 1440, h: 120 },
                  computedStyle: { display: "flex", position: "relative" },
                },
              ],
            };
          }),
        },
      };

      const log = vi.fn();
      const res = await visualExtractor.run({
        graph: g,
        page: mockPage,
        pageNode,
        budget: DEFAULT_BUDGET,
        log,
        viewports: [DEFAULT_VIEWPORT_PROFILES.desktop, DEFAULT_VIEWPORT_PROFILES.mobile],
      });

      expect(res.produced).toBe(true);
      expect(mockPage.setViewport).toHaveBeenCalledTimes(2);

      // Verify ax identity remains intact
      const ax = g.getAx("ax:banner");
      expect(ax).toBeDefined();

      // Observations recorded for both profiles
      const obs = g.visualObservationsByAx("ax:banner");
      expect(obs).toHaveLength(2);

      // queryViewportDiff computes deltas
      const diff = g.queryViewportDiff("ax:banner", "desktop", "mobile");
      expect(diff).not.toBeNull();
      expect(diff?.rectDelta.dw).toBe(390 - 1440);
      expect(diff?.rectDelta.dh).toBe(80 - 120);
      expect(diff?.summary).toContain("resized from 1440×120 at desktop(1440px) to 390×80 at mobile(390px)");
    });
  });

});
