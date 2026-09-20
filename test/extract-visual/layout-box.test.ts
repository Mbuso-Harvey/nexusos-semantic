/**
 * VI-02: Layout box model and visual evidence capture tests.
 */
import { describe, it, expect, vi } from "vitest";
import {
  computeBoxModel,
  computeStackingContext,
  computeScrollClippingContext,
  classifyVisualContainer,
  computeRenderBounds,
  visualExtractor,
} from "../../src/extract-visual/visual.js";
import { Graph } from "../../src/graph/graph.js";
import { query } from "../../src/graph/query.js";
import { SqliteGraphStore } from "../../src/store/sqlite-store.js";
import type { PageNode } from "../../src/graph/types.js";
import { DEFAULT_VIEWPORT_PROFILES } from "../../src/graph/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_ID = "page:https://example.com/";

function makePageNode(): PageNode {
  return {
    id: PAGE_ID,
    type: "page",
    url: "https://example.com/",
    title: "Layout Box Test",
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
}

describe("VI-02: Pure layout box calculations", () => {
  describe("computeBoxModel", () => {
    it("computes all 4 box model layers and edge insets accurately", () => {
      const rect = { x: 50, y: 100, w: 300, h: 200 };
      const computedStyle = {
        "box-sizing": "border-box",
        "margin-top": "15px",
        "margin-right": "20px",
        "margin-bottom": "25px",
        "margin-left": "10px",
        "border-top-width": "2px",
        "border-right-width": "4px",
        "border-bottom-width": "6px",
        "border-left-width": "8px",
        "padding-top": "12px",
        "padding-right": "16px",
        "padding-bottom": "14px",
        "padding-left": "18px",
      };

      const bm = computeBoxModel(rect, computedStyle);

      expect(bm.margin).toEqual({ top: 15, right: 20, bottom: 25, left: 10 });
      expect(bm.border).toEqual({ top: 2, right: 4, bottom: 6, left: 8 });
      expect(bm.padding).toEqual({ top: 12, right: 16, bottom: 14, left: 18 });
      expect(bm.boxSizing).toBe("border-box");
      expect(bm.borderBox).toEqual({ x: 50, y: 100, w: 300, h: 200 });

      expect(bm.paddingBox).toEqual({
        x: 58,
        y: 102,
        w: 288,
        h: 192,
      });

      expect(bm.content).toEqual({
        x: 76,
        y: 114,
        w: 254,
        h: 166,
      });

      expect(bm.marginBox).toEqual({
        x: 40,
        y: 85,
        w: 330,
        h: 240,
      });
    });

    it("falls back gracefully when margin/border/padding styles are missing", () => {
      const rect = { x: 0, y: 0, w: 100, h: 50 };
      const bm = computeBoxModel(rect, {});
      expect(bm.margin).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
      expect(bm.border).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
      expect(bm.padding).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
      expect(bm.borderBox).toEqual(rect);
      expect(bm.paddingBox).toEqual(rect);
      expect(bm.content).toEqual(rect);
      expect(bm.marginBox).toEqual(rect);
      expect(bm.boxSizing).toBe("content-box");
    });
  });

  describe("computeStackingContext", () => {
    it("identifies root stacking context", () => {
      const info = computeStackingContext({}, true);
      expect(info.isStackingContext).toBe(true);
      expect(info.reasons).toContain("root");
      expect(info.zIndex).toBe("auto");
    });

    it("identifies position + z-index trigger", () => {
      const info = computeStackingContext({ position: "relative", "z-index": "10" });
      expect(info.isStackingContext).toBe(true);
      expect(info.reasons).toContain("position:relative z-index:10");
      expect(info.zIndex).toBe(10);
    });

    it("does not create stacking context for position: static with z-index", () => {
      const info = computeStackingContext({ position: "static", "z-index": "10" });
      expect(info.isStackingContext).toBe(false);
      expect(info.zIndex).toBe(10);
      expect(info.reasons).toHaveLength(0);
    });

    it("identifies fixed and sticky position triggers", () => {
      const fixed = computeStackingContext({ position: "fixed" });
      expect(fixed.isStackingContext).toBe(true);
      expect(fixed.reasons).toContain("position:fixed");

      const sticky = computeStackingContext({ position: "sticky" });
      expect(sticky.isStackingContext).toBe(true);
      expect(sticky.reasons).toContain("position:sticky");
    });

    it("identifies CSS effect triggers: opacity, transform, filter, isolation", () => {
      const info = computeStackingContext({
        opacity: "0.8",
        transform: "scale(1.1)",
        filter: "blur(2px)",
        isolation: "isolate",
      });
      expect(info.isStackingContext).toBe(true);
      expect(info.reasons).toContain("opacity:0.8");
      expect(info.reasons).toContain("transform");
      expect(info.reasons).toContain("filter");
      expect(info.reasons).toContain("isolation:isolate");
    });
  });

  describe("computeScrollClippingContext", () => {
    it("detects scroll container with explicit overflow and scrollable overflow dimensions", () => {
      const metrics = {
        scrollWidth: 800,
        scrollHeight: 1200,
        scrollLeft: 50,
        scrollTop: 100,
        clientWidth: 400,
        clientHeight: 300,
      };
      const cs = {
        "overflow-x": "auto",
        "overflow-y": "scroll",
        "clip-path": "circle(50% at 50% 50%)",
      };

      const ctx = computeScrollClippingContext(metrics, cs, "ax:parent-scroller");
      expect(ctx.isScrollContainer).toBe(true);
      expect(ctx.canScrollX).toBe(true);
      expect(ctx.canScrollY).toBe(true);
      expect(ctx.isClipped).toBe(true);
      expect(ctx.scrollWidth).toBe(800);
      expect(ctx.scrollHeight).toBe(1200);
      expect(ctx.scrollLeft).toBe(50);
      expect(ctx.scrollTop).toBe(100);
      expect(ctx.clipPath).toBe("circle(50% at 50% 50%)");
      expect(ctx.scrollContainerAxId).toBe("ax:parent-scroller");
    });

    it("correctly identifies non-scrollable unclipped elements", () => {
      const metrics = {
        scrollWidth: 200,
        scrollHeight: 100,
        scrollLeft: 0,
        scrollTop: 0,
        clientWidth: 200,
        clientHeight: 100,
      };
      const cs = { overflow: "visible" };

      const ctx = computeScrollClippingContext(metrics, cs);
      expect(ctx.isScrollContainer).toBe(false);
      expect(ctx.canScrollX).toBe(false);
      expect(ctx.canScrollY).toBe(false);
      expect(ctx.isClipped).toBe(false);
      expect(ctx.clipPath).toBeNull();
    });
  });

  describe("classifyVisualContainer", () => {
    it("classifies grid and flex containers", () => {
      expect(classifyVisualContainer({ tag: "div" }, { display: "grid" })).toEqual({
        isVisualContainer: true,
        containerType: "grid",
      });
      expect(classifyVisualContainer({ tag: "div" }, { display: "flex" })).toEqual({
        isVisualContainer: true,
        containerType: "flex",
      });
    });

    it("classifies hero and banner wrappers", () => {
      const hero = classifyVisualContainer(
        { tag: "div", className: "home-hero-banner", rect: { x: 0, y: 0, w: 1200, h: 400 } },
        { display: "block" },
      );
      expect(hero).toEqual({ isVisualContainer: true, containerType: "hero" });
    });

    it("classifies cards by class or styled borders and shadows", () => {
      const cardByClass = classifyVisualContainer(
        { tag: "div", className: "product-card", rect: { x: 10, y: 10, w: 250, h: 300 } },
        {},
      );
      expect(cardByClass).toEqual({ isVisualContainer: true, containerType: "card" });

      const styledCard = classifyVisualContainer(
        { tag: "div", rect: { x: 10, y: 10, w: 250, h: 300 } },
        {
          "border-top-width": "1px",
          "border-right-width": "1px",
          "border-bottom-width": "1px",
          "border-left-width": "1px",
          "border-style": "solid",
          "border-radius": "8px",
          "background-color": "#ffffff",
        },
      );
      expect(styledCard).toEqual({ isVisualContainer: true, containerType: "card" });
    });

    it("classifies landmark semantic sections", () => {
      for (const tag of ["section", "article", "main", "aside", "nav", "header", "footer"]) {
        expect(classifyVisualContainer({ tag }, {})).toEqual({
          isVisualContainer: true,
          containerType: "section",
        });
      }
    });

    it("returns none for plain unstyled inline content", () => {
      const plain = classifyVisualContainer(
        { tag: "span", rect: { x: 0, y: 0, w: 20, h: 10 } },
        { display: "inline" },
      );
      expect(plain).toEqual({ isVisualContainer: false, containerType: "none" });
    });
  });

  describe("computeRenderBounds", () => {
    it("disambiguates pre-transform layout bounds from post-transform rendered bounds", () => {
      const postTransformRect = { x: 60, y: 110, w: 330, h: 220 };
      const preTransformLayout = { x: 50, y: 100, w: 300, h: 200 };
      const cs = { transform: "matrix(1.1, 0, 0, 1.1, 10, 10)" };

      const bounds = computeRenderBounds(postTransformRect, preTransformLayout, cs);
      expect(bounds.hasTransform).toBe(true);
      expect(bounds.transform).toBe("matrix(1.1, 0, 0, 1.1, 10, 10)");
      expect(bounds.transformed).toEqual(postTransformRect);
      expect(bounds.layout).toEqual(preTransformLayout);
    });

    it("handles elements with no transform", () => {
      const rect = { x: 50, y: 100, w: 300, h: 200 };
      const bounds = computeRenderBounds(rect, rect, { transform: "none" });
      expect(bounds.hasTransform).toBe(false);
      expect(bounds.transform).toBeNull();
      expect(bounds.transformed).toEqual(rect);
      expect(bounds.layout).toEqual(rect);
    });
  });
});
