import { describe, it, expect } from "vitest";
import {
  diffVisualNodes,
  diffPageVisualRegression,
} from "../../src/extract-visual/regression.js";
import type { VisualNode } from "../../src/graph/types.js";

function makeVis(partial: Partial<VisualNode>): VisualNode {
  return {
    id: "vis:page:/:el-1",
    type: "visual-node",
    axId: "ax:el-1",
    pageId: "page:/",
    rect: { x: 100, y: 100, w: 200, h: 50 },
    computedStyle: {
      display: "block",
      position: "relative",
      backgroundColor: "rgb(0, 102, 204)",
      color: "rgb(255, 255, 255)",
      fontSize: "16px",
    },
    designTokenRefs: ["color.primary"],
    designTokenBindings: [
      {
        tokenPath: "color.primary",
        property: "backgroundColor",
        tokenValue: "#0066cc",
        actualValue: "rgb(0, 102, 204)",
        matchType: "exact",
        confidence: 1.0,
      },
    ],
    tethers: {
      parent: null,
      children: [],
      siblingsBefore: [],
      siblingsAfter: [],
      anchors: [],
    },
    provenance: "bidi:script.callFunction",
    viewport: { name: "desktop", w: 1440, h: 900, dpr: 1 },
    ...partial,
  };
}

describe("Visual Regression Diffing (VI-05)", () => {
  it("reports no defects for identical nodes", () => {
    const base = makeVis({});
    const cand = makeVis({});
    const diff = diffVisualNodes(base, cand);
    expect(diff.hasRegression).toBe(false);
    expect(diff.defects).toHaveLength(0);
    expect(diff.maxSeverity).toBe("none");
    expect(diff.layoutShiftScore).toBe(0);
  });

  it("detects layout shifts and calculates CWV layoutShiftScore", () => {
    const base = makeVis({ rect: { x: 100, y: 100, w: 200, h: 50 } });
    const cand = makeVis({ rect: { x: 100, y: 250, w: 200, h: 50 } });
    const diff = diffVisualNodes(base, cand);

    expect(diff.hasRegression).toBe(true);
    expect(diff.layoutShiftScore).toBeGreaterThan(0);
    const shiftDefect = diff.defects.find((d) => d.kind === "layout-shift");
    expect(shiftDefect).toBeDefined();
    expect(["high", "critical"]).toContain(shiftDefect?.severity);
  });

  it("detects dimension changes", () => {
    const base = makeVis({ rect: { x: 100, y: 100, w: 200, h: 50 } });
    const cand = makeVis({ rect: { x: 100, y: 100, w: 400, h: 50 } }); // +100% width
    const diff = diffVisualNodes(base, cand);

    expect(diff.hasRegression).toBe(true);
    const dimDefect = diff.defects.find((d) => d.kind === "dimension-change");
    expect(dimDefect).toBeDefined();
    expect(dimDefect?.description).toContain("400x50");
  });

  it("detects style drift on colors", () => {
    const base = makeVis({
      computedStyle: {
        backgroundColor: "rgb(0, 102, 204)",
      },
    });
    const cand = makeVis({
      computedStyle: {
        backgroundColor: "rgb(200, 0, 0)", // significantly different color
      },
    });
    const diff = diffVisualNodes(base, cand);
    expect(diff.hasRegression).toBe(true);
    const styleDefect = diff.defects.find((d) => d.kind === "style-drift");
    expect(styleDefect).toBeDefined();
    expect(styleDefect?.description).toContain("backgroundColor");
  });

  it("detects token detachment regressions", () => {
    const base = makeVis({
      designTokenBindings: [
        {
          tokenPath: "color.primary",
          property: "backgroundColor",
          tokenValue: "#0066cc",
          actualValue: "rgb(0, 102, 204)",
          matchType: "exact",
          confidence: 1.0,
        },
      ],
    });
    const cand = makeVis({
      designTokenBindings: [], // Dropped token binding
      designTokenRefs: [],
    });
    const diff = diffVisualNodes(base, cand);
    expect(diff.hasRegression).toBe(true);
    const detachDefect = diff.defects.find((d) => d.kind === "token-detachment");
    expect(detachDefect).toBeDefined();
    expect(detachDefect?.description).toContain("color.primary");
  });

  it("detects occlusion regressions", () => {
    const base = makeVis({
      occlusion: {
        isOccluded: false,
        visibleRatio: 1.0,
        occludedArea: 0,
        visibleArea: 10000,
        occludedBy: [],
        clippedRect: { x: 100, y: 100, w: 200, h: 50 },
        isOffscreen: false,
      },
    });
    const cand = makeVis({
      occlusion: {
        isOccluded: true,
        visibleRatio: 0.1, // Drastic occlusion drop
        occludedArea: 9000,
        visibleArea: 1000,
        occludedBy: ["ax:overlay"],
        clippedRect: { x: 100, y: 100, w: 200, h: 50 },
        isOffscreen: false,
      },
    });
    const diff = diffVisualNodes(base, cand);
    expect(diff.hasRegression).toBe(true);
    const occDefect = diff.defects.find((d) => d.kind === "visibility-regression");
    expect(occDefect).toBeDefined();
    expect(occDefect?.severity).toBe("critical");
  });

  it("detects semantic visual pattern degradation", () => {
    const base = makeVis({
      primaryPattern: "fab",
      patterns: [{ pattern: "fab", confidence: 0.95, reasons: ["position:fixed"] }],
    });
    const cand = makeVis({
      primaryPattern: undefined,
      patterns: [],
    });
    const diff = diffVisualNodes(base, cand);
    expect(diff.hasRegression).toBe(true);
    const patDefect = diff.defects.find((d) => d.kind === "pattern-degradation");
    expect(patDefect).toBeDefined();
    expect(patDefect?.severity).toBe("high");
  });

  describe("diffPageVisualRegression", () => {
    it("aggregates full page regressions, CLS score, and added/removed nodes", () => {
      const baseNodes: VisualNode[] = [
        makeVis({ axId: "ax:header", rect: { x: 0, y: 0, w: 1440, h: 60 } }),
        makeVis({ axId: "ax:btn", rect: { x: 100, y: 100, w: 200, h: 50 } }),
        makeVis({ axId: "ax:footer", rect: { x: 0, y: 800, w: 1440, h: 100 } }),
      ];

      const candNodes: VisualNode[] = [
        makeVis({ axId: "ax:header", rect: { x: 0, y: 0, w: 1440, h: 60 } }), // identical
        makeVis({ axId: "ax:btn", rect: { x: 100, y: 200, w: 200, h: 50 } }), // shifted
        makeVis({ axId: "ax:new-banner", rect: { x: 0, y: 60, w: 1440, h: 40 } }), // added
        // ax:footer is removed
      ];

      const report = diffPageVisualRegression(baseNodes, candNodes, "page:/");

      expect(report.pageId).toBe("page:/");
      expect(report.totalNodesCompared).toBe(3);
      expect(report.regressedNodesCount).toBeGreaterThan(0);
      expect(report.addedNodes).toEqual(["ax:new-banner"]);
      expect(report.removedNodes).toEqual(["ax:footer"]);
      expect(report.cumulativeLayoutShift).toBeGreaterThan(0);
      expect(report.counts.high + report.counts.critical + report.counts.medium).toBeGreaterThan(0);
    });
  });
});
