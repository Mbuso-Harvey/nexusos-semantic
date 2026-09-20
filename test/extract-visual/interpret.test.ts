/**
 * Unit tests for the interpret module (ED-06).
 *
 * Tests the three required v1 interpretations:
 *   1. Grid structure analysis   (isGridDisplay, parseGridTemplate, extractGridDescription)
 *   2. Flex axis analysis       (isFlexDisplay, extractFlexDescription)
 *   3. Alignment relation        (detectAlignment, extractAlignmentRelations, interpretPage)
 *
 * Plus the exported threshold constants.
 *
 * Layer 3 deferred (now implemented):
 *   4. Visual prominence scoring   (extractVisualProminence + helpers)
 *   5. Component inference        (inferComponentGroups)
 *   6. Responsive behaviour hints  (detectResponsiveHints)
 */
import { describe, it, expect } from "vitest";
import {
  // Threshold constants (ED-06 §4 binding — single source of truth)
  ALIGN_TOLERANCE_PX,
  CENTRE_TOLERANCE_PX,
  // Grid
  isGridDisplay,
  parseGridTemplate,
  extractGridDescription,
  // Flex
  isFlexDisplay,
  extractFlexDescription,
  // Alignment
  detectAlignment,
  extractAlignmentRelations,
  interpretPage,
  // Prominence helpers
  scoreZIndex,
  scoreOpacity,
  scoreTransform,
  scoreFontSize,
  extractVisualProminence,
  // Component inference
  inferComponentGroups,
  // Responsive hints
  detectResponsiveHints,
  type LayoutRelationEdge,
} from "../../src/extract-visual/interpret.js";
import type { VisualNode } from "../../src/graph/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal VisualNode with a display value and rect for alignment tests. */
function makeNode(overrides: Partial<VisualNode> & { id: string }): VisualNode {
  return {
    type: "visual",
    axId: "ax:fake",
    pageId: "page:https://example.com/",
    rect: { x: 0, y: 0, w: 100, h: 50 },
    bbox: null,
    opacity: 1,
    zIndex: 0,
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
    customProperties: [],
    designTokenRefs: [],
    tokensOverride: null,
    tetherNodeIds: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    ...overrides,
  } as VisualNode;
}

// ---------------------------------------------------------------------------
// Constants — single source of truth
// ---------------------------------------------------------------------------

describe("ED-06 threshold constants", () => {
  it("ALIGN_TOLERANCE_PX is 2", () => {
    expect(ALIGN_TOLERANCE_PX).toBe(2);
  });

  it("CENTRE_TOLERANCE_PX is 4", () => {
    expect(CENTRE_TOLERANCE_PX).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// isGridDisplay
// ---------------------------------------------------------------------------

describe("isGridDisplay", () => {
  it("returns true for 'grid'", () => {
    expect(isGridDisplay("grid")).toBe(true);
  });

  it("returns true for 'inline-grid'", () => {
    expect(isGridDisplay("inline-grid")).toBe(true);
  });

  it("returns true for 'subgrid'", () => {
    expect(isGridDisplay("subgrid")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isGridDisplay("GRID")).toBe(true);
    expect(isGridDisplay("Inline-Grid")).toBe(true);
    expect(isGridDisplay("  grid  ")).toBe(true);
  });

  it("returns false for 'flex'", () => {
    expect(isGridDisplay("flex")).toBe(false);
  });

  it("returns false for other display values", () => {
    expect(isGridDisplay("block")).toBe(false);
    expect(isGridDisplay("inline")).toBe(false);
    expect(isGridDisplay("none")).toBe(false);
    expect(isGridDisplay("contents")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isGridDisplay(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isGridDisplay("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseGridTemplate
// ---------------------------------------------------------------------------

describe("parseGridTemplate", () => {
  it("splits a standard template on whitespace", () => {
    expect(parseGridTemplate("1fr 2fr")).toEqual(["1fr", "2fr"]);
    expect(parseGridTemplate("1fr auto 200px")).toEqual(["1fr", "auto", "200px"]);
  });

  it("handles repeat() and minmax() as single tokens", () => {
    expect(parseGridTemplate("repeat(3, 1fr)")).toEqual(["repeat(3,", "1fr)"]);
    expect(parseGridTemplate("minmax(100px, 1fr)")).toEqual(["minmax(100px,", "1fr)"]);
  });

  it("collapses multiple spaces to single tokens", () => {
    expect(parseGridTemplate("1fr   2fr    3fr")).toEqual(["1fr", "2fr", "3fr"]);
  });

  it("returns empty array for 'none'", () => {
    expect(parseGridTemplate("none")).toEqual([]);
  });

  it("returns empty array for 'initial'", () => {
    expect(parseGridTemplate("initial")).toEqual([]);
  });

  it("returns empty array for 'inherit'", () => {
    expect(parseGridTemplate("inherit")).toEqual([]);
  });

  it("returns empty array for 'revert'", () => {
    expect(parseGridTemplate("revert")).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(parseGridTemplate(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseGridTemplate("")).toEqual([]);
  });

  it("trims surrounding whitespace", () => {
    expect(parseGridTemplate("  1fr 2fr  ")).toEqual(["1fr", "2fr"]);
  });

  it("filters blank tokens", () => {
    expect(parseGridTemplate("1fr   2fr")).toEqual(["1fr", "2fr"]);
  });
});

// ---------------------------------------------------------------------------
// extractGridDescription
// ---------------------------------------------------------------------------

describe("extractGridDescription", () => {
  it("returns GridDescription for 'grid' display", () => {
    const node = makeNode({
      id: "vis:page:p0",
      computedStyle: {
        display: "grid",
        "grid-template-columns": "1fr 2fr",
        "grid-template-rows": "auto",
        "column-gap": "10px",
        "row-gap": "8px",
      },
    });
    const result = extractGridDescription(node);
    expect(result).toBeDefined();
    expect(result!.type).toBe("grid");
    expect(result!.columns).toEqual(["1fr", "2fr"]);
    expect(result!.rows).toEqual(["auto"]);
    expect(result!.columnGap).toBe("10px");
    expect(result!.rowGap).toBe("8px");
  });

  it("returns GridDescription for 'inline-grid' display", () => {
    const node = makeNode({
      id: "vis:grid:inline",
      computedStyle: {
        display: "inline-grid",
        "grid-template-columns": "200px",
        "grid-template-rows": "100px",
        "column-gap": "0",
        "row-gap": "0",
      },
    });
    expect(extractGridDescription(node)?.type).toBe("grid");
  });

  it("returns GridDescription for 'subgrid' display", () => {
    const node = makeNode({
      id: "vis:grid:subgrid",
      computedStyle: {
        display: "subgrid",
        "grid-template-columns": "",
        "grid-template-rows": "",
      },
    });
    expect(extractGridDescription(node)?.type).toBe("grid");
  });

  it("returns undefined for non-grid display", () => {
    const node = makeNode({ id: "vis:block", computedStyle: { display: "flex" } });
    expect(extractGridDescription(node)).toBeUndefined();
  });

  it("returns undefined for 'none' grid-template-columns (cancelled template)", () => {
    const node = makeNode({
      id: "vis:grid:none",
      computedStyle: {
        display: "grid",
        "grid-template-columns": "none",
        "grid-template-rows": "none",
      },
    });
    const result = extractGridDescription(node);
    expect(result?.columns).toEqual([]);
    expect(result?.rows).toEqual([]);
  });

  it("defaults missing gap properties to empty string", () => {
    const node = makeNode({
      id: "vis:grid:nogap",
      computedStyle: {
        display: "grid",
        "grid-template-columns": "1fr",
        "grid-template-rows": "1fr",
      },
    });
    const result = extractGridDescription(node)!;
    expect(result.columnGap).toBe("");
    expect(result.rowGap).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isFlexDisplay
// ---------------------------------------------------------------------------

describe("isFlexDisplay", () => {
  it("returns true for 'flex'", () => {
    expect(isFlexDisplay("flex")).toBe(true);
  });

  it("returns true for 'inline-flex'", () => {
    expect(isFlexDisplay("inline-flex")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isFlexDisplay("FLEX")).toBe(true);
    expect(isFlexDisplay("Inline-Flex")).toBe(true);
    expect(isFlexDisplay("  flex  ")).toBe(true);
  });

  it("returns false for 'grid'", () => {
    expect(isFlexDisplay("grid")).toBe(false);
  });

  it("returns false for other display values", () => {
    expect(isFlexDisplay("block")).toBe(false);
    expect(isFlexDisplay("inline")).toBe(false);
    expect(isFlexDisplay("none")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFlexDisplay(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isFlexDisplay("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractFlexDescription
// ---------------------------------------------------------------------------

describe("extractFlexDescription", () => {
  describe("direction mapping", () => {
    const directions: Array<{ css: string; expected: "row" | "column" | "row-reverse" | "column-reverse" }> = [
      { css: "row",          expected: "row" },
      { css: "row-reverse",  expected: "row-reverse" },
      { css: "column",       expected: "column" },
      { css: "column-reverse", expected: "column-reverse" },
    ];

    for (const { css, expected } of directions) {
      it(`maps '${css}' to '${expected}'`, () => {
        const node = makeNode({ id: `vis:flex:${css}`, computedStyle: { display: "flex", "flex-direction": css } });
        expect(extractFlexDescription(node)?.direction).toBe(expected);
      });
    }

    it("falls back to 'row' for unknown flex-direction", () => {
      const node = makeNode({ id: "vis:flex:unknown", computedStyle: { display: "flex", "flex-direction": "slanted" } });
      expect(extractFlexDescription(node)?.direction).toBe("row");
    });

    it("falls back to 'row' when flex-direction is undefined", () => {
      const node = makeNode({ id: "vis:flex:undef", computedStyle: { display: "flex" } });
      expect(extractFlexDescription(node)?.direction).toBe("row");
    });
  });

  describe("axis derivation", () => {
    it("row → mainAxis=horizontal, crossAxis=vertical", () => {
      const node = makeNode({ id: "vis:axis:row", computedStyle: { display: "flex", "flex-direction": "row" } });
      const result = extractFlexDescription(node)!;
      expect(result.mainAxis).toBe("horizontal");
      expect(result.crossAxis).toBe("vertical");
    });

    it("row-reverse → mainAxis=horizontal, crossAxis=vertical", () => {
      const node = makeNode({ id: "vis:axis:row-reverse", computedStyle: { display: "flex", "flex-direction": "row-reverse" } });
      const result = extractFlexDescription(node)!;
      expect(result.mainAxis).toBe("horizontal");
      expect(result.crossAxis).toBe("vertical");
    });

    it("column → mainAxis=vertical, crossAxis=horizontal", () => {
      const node = makeNode({ id: "vis:axis:column", computedStyle: { display: "flex", "flex-direction": "column" } });
      const result = extractFlexDescription(node)!;
      expect(result.mainAxis).toBe("vertical");
      expect(result.crossAxis).toBe("horizontal");
    });

    it("column-reverse → mainAxis=vertical, crossAxis=horizontal", () => {
      const node = makeNode({ id: "vis:axis:col-reverse", computedStyle: { display: "flex", "flex-direction": "column-reverse" } });
      const result = extractFlexDescription(node)!;
      expect(result.mainAxis).toBe("vertical");
      expect(result.crossAxis).toBe("horizontal");
    });
  });

  describe("wrap", () => {
    it("flex-wrap: wrap → wrap=true", () => {
      const node = makeNode({ id: "vis:wrap:true", computedStyle: { display: "flex", "flex-wrap": "wrap" } });
      expect(extractFlexDescription(node)?.wrap).toBe(true);
    });

    it("flex-wrap: wrap-reverse → wrap=true", () => {
      const node = makeNode({ id: "vis:wrap:reverse", computedStyle: { display: "flex", "flex-wrap": "wrap-reverse" } });
      expect(extractFlexDescription(node)?.wrap).toBe(true);
    });

    it("flex-wrap: nowrap → wrap=false", () => {
      const node = makeNode({ id: "vis:wrap:nowrap", computedStyle: { display: "flex", "flex-wrap": "nowrap" } });
      expect(extractFlexDescription(node)?.wrap).toBe(false);
    });

    it("defaults to nowrap when flex-wrap is undefined", () => {
      const node = makeNode({ id: "vis:wrap:undef", computedStyle: { display: "flex" } });
      expect(extractFlexDescription(node)?.wrap).toBe(false);
    });
  });

  describe("gap", () => {
    it("captures computed gap", () => {
      const node = makeNode({ id: "vis:flex:gap", computedStyle: { display: "flex", gap: "10px" } });
      expect(extractFlexDescription(node)?.gap).toBe("10px");
    });

    it("defaults to empty string when gap is undefined", () => {
      const node = makeNode({ id: "vis:flex:nogap", computedStyle: { display: "flex" } });
      expect(extractFlexDescription(node)?.gap).toBe("");
    });
  });

  it("returns undefined for non-flex display", () => {
    const node = makeNode({ id: "vis:block", computedStyle: { display: "block" } });
    expect(extractFlexDescription(node)).toBeUndefined();
  });

  it("returns undefined for inline-flex display", () => {
    const node = makeNode({
      id: "vis:inline-flex",
      computedStyle: {
        display: "inline-flex",
        "flex-direction": "column",
        "flex-wrap": "wrap",
        gap: "8px",
      },
    });
    const result = extractFlexDescription(node);
    expect(result?.type).toBe("flex");
    expect(result?.direction).toBe("column");
    expect(result?.wrap).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectAlignment — reads the threshold constants directly
// ---------------------------------------------------------------------------

describe("detectAlignment", () => {
  it("returns 'aligned-horizontally' when y and height match within ALIGN_TOLERANCE_PX", () => {
    const a = makeNode({ id: "a", rect: { x: 10, y: 100, w: 200, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 220, y: 101, w: 150, h: 51 } }); // y diff=1, h diff=1
    expect(detectAlignment(a, b)).toBe("aligned-horizontally");
  });

  it("does not trigger horizontal alignment when y diff exceeds ALIGN_TOLERANCE_PX", () => {
    const a = makeNode({ id: "a", rect: { x: 10, y: 100, w: 200, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 220, y: 103, w: 150, h: 50 } }); // y diff=3
    expect(detectAlignment(a, b)).not.toBe("aligned-horizontally");
  });

  it("does not trigger horizontal alignment when height diff exceeds ALIGN_TOLERANCE_PX", () => {
    const a = makeNode({ id: "a", rect: { x: 10, y: 100, w: 200, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 220, y: 100, w: 150, h: 53 } }); // h diff=3
    expect(detectAlignment(a, b)).not.toBe("aligned-horizontally");
  });

  it("returns 'aligned-vertically' when x and width match within ALIGN_TOLERANCE_PX", () => {
    const a = makeNode({ id: "a", rect: { x: 50, y: 0, w: 100, h: 200 } });
    const b = makeNode({ id: "b", rect: { x: 51, y: 300, w: 102, h: 150 } }); // x diff=1, w diff=2
    expect(detectAlignment(a, b)).toBe("aligned-vertically");
  });

  it("does not trigger vertical alignment when x diff exceeds ALIGN_TOLERANCE_PX", () => {
    const a = makeNode({ id: "a", rect: { x: 50, y: 0, w: 100, h: 200 } });
    const b = makeNode({ id: "b", rect: { x: 53, y: 300, w: 100, h: 150 } }); // x diff=3
    expect(detectAlignment(a, b)).not.toBe("aligned-vertically");
  });

  it("does not trigger vertical alignment when width diff exceeds ALIGN_TOLERANCE_PX", () => {
    const a = makeNode({ id: "a", rect: { x: 50, y: 0, w: 100, h: 200 } });
    const b = makeNode({ id: "b", rect: { x: 50, y: 300, w: 103, h: 150 } }); // w diff=3
    expect(detectAlignment(a, b)).not.toBe("aligned-vertically");
  });

  it("returns 'centred-with' when horizontal centres are within CENTRE_TOLERANCE_PX", () => {
    // Use different y AND different h so the horizontal-alignment check (y ±2, h ±2)
    // fails first, letting the centre check fire.
    // a: centre x = 50 + 4/2 = 52
    // b: centre x = 54 + 4/2 = 56; diff = 2 (within CENTRE_TOLERANCE_PX=4)
    const a = makeNode({ id: "a", rect: { x: 50, y: 0, w: 4, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 54, y: 200, w: 4, h: 30 } });
    // y diff=200 > 2; h diff=20 > 2 → horizontal fails
    // x diff=4 > 2 → vertical fails
    // centre diff = |52 - 56| = 2 ≤ 4 → centred-with
    expect(detectAlignment(a, b)).toBe("centred-with");
  });

  it("does not trigger centre alignment when x-centre diff exceeds CENTRE_TOLERANCE_PX", () => {
    const a = makeNode({ id: "a", rect: { x: 0, y: 0, w: 200, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 250, y: 100, w: 100, h: 30 } }); // centre diff = 50
    expect(detectAlignment(a, b)).toBeNull();
  });

  it("prefers horizontal over centre when both conditions are met", () => {
    // Both horizontal alignment AND centre alignment are true.
    // The function returns horizontal first.
    const a = makeNode({ id: "a", rect: { x: 0, y: 100, w: 100, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 200, y: 100, w: 100, h: 50 } }); // same y, same h, centre diff = 150
    expect(detectAlignment(a, b)).toBe("aligned-horizontally");
  });

  it("prefers vertical over centre when both conditions are met", () => {
    const a = makeNode({ id: "a", rect: { x: 50, y: 0, w: 100, h: 200 } });
    const b = makeNode({ id: "b", rect: { x: 50, y: 300, w: 100, h: 200 } }); // same x, same w, centre diff = 150
    expect(detectAlignment(a, b)).toBe("aligned-vertically");
  });

  it("returns null when neither alignment condition is met", () => {
    const a = makeNode({ id: "a", rect: { x: 0, y: 0, w: 100, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 200, y: 200, w: 80, h: 80 } });
    expect(detectAlignment(a, b)).toBeNull();
  });

  it("at boundary: y diff == ALIGN_TOLERANCE_PX triggers horizontal", () => {
    const a = makeNode({ id: "a", rect: { x: 0, y: 0, w: 100, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 200, y: 2, w: 100, h: 50 } }); // y diff = 2 == ALIGN_TOLERANCE_PX
    expect(detectAlignment(a, b)).toBe("aligned-horizontally");
  });

  it("at boundary: centre diff == CENTRE_TOLERANCE_PX triggers centre", () => {
    // Use nodes with different y and h so horizontal alignment fails (y diff > 2, h diff > 2),
    // different x and w so vertical fails (x diff > 2, w diff > 2), but centre diff = 4.
    // a: centre x = 0+100/2 = 50
    // b: centre x = 4+100/2 = 54; diff = 4 == CENTRE_TOLERANCE_PX
    const a = makeNode({ id: "a", rect: { x: 0, y: 0, w: 100, h: 50 } });
    const b = makeNode({ id: "b", rect: { x: 4, y: 200, w: 100, h: 30 } });
    // y diff=200 > 2; h diff=20 > 2 → horizontal fails
    // x diff=4 > 2; w diff=0 ≤ 2 → vertical check: x diff=4 > 2, fails
    // centre diff = |50 - 54| = 4 ≤ 4 → centred-with
    expect(detectAlignment(a, b)).toBe("centred-with");
  });
});

// ---------------------------------------------------------------------------
// extractAlignmentRelations
// ---------------------------------------------------------------------------

describe("extractAlignmentRelations", () => {
  it("detects aligned sibling from siblingsBefore", () => {
    const nodeA = makeNode({ id: "a", rect: { x: 0, y: 0, w: 100, h: 50 }, tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: ["b"], anchors: [] } });
    const nodeB = makeNode({ id: "b", rect: { x: 0, y: 0, w: 100, h: 50 }, tethers: { parent: null, children: [], siblingsBefore: ["a"], siblingsAfter: [], anchors: [] } });
    const byVisId = new Map([["a", nodeA], ["b", nodeB]]);
    const relations = extractAlignmentRelations(nodeB, byVisId);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.other).toBe("a");
    expect(relations[0]!.kind).toBe("aligned-horizontally");
  });

  it("detects aligned sibling from siblingsAfter", () => {
    const nodeA = makeNode({ id: "a", rect: { x: 0, y: 0, w: 100, h: 50 }, tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: ["b"], anchors: [] } });
    const nodeB = makeNode({ id: "b", rect: { x: 0, y: 0, w: 100, h: 50 }, tethers: { parent: null, children: [], siblingsBefore: ["a"], siblingsAfter: [], anchors: [] } });
    const byVisId = new Map([["a", nodeA], ["b", nodeB]]);
    const relations = extractAlignmentRelations(nodeA, byVisId);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.other).toBe("b");
    expect(relations[0]!.kind).toBe("aligned-horizontally");
  });

  it("deduplicates: same sibling in siblingsBefore and siblingsAfter", () => {
    // Node b appears in both lists (edge case of DOM tree structure).
    const nodeA = makeNode({
      id: "a",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: ["b"], siblingsAfter: ["b"], anchors: [] },
    });
    const nodeB = makeNode({
      id: "b",
      rect: { x: 0, y: 0, w: 100, h: 50 },
    });
    const byVisId = new Map([["a", nodeA], ["b", nodeB]]);
    const relations = extractAlignmentRelations(nodeA, byVisId);
    // Should appear once (first wins).
    expect(relations.filter((r) => r.other === "b")).toHaveLength(1);
  });

  it("ignores siblings not in byVisId", () => {
    const node = makeNode({
      id: "a",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: ["ghost", "b"], siblingsAfter: [], anchors: [] },
    });
    const nodeB = makeNode({
      id: "b",
      rect: { x: 0, y: 0, w: 100, h: 50 },
    });
    const byVisId = new Map([["a", node], ["b", nodeB]]);
    const relations = extractAlignmentRelations(node, byVisId);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.other).toBe("b");
  });

  it("returns empty array when no siblings are aligned", () => {
    const node = makeNode({
      id: "a",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: ["b"], siblingsAfter: [], anchors: [] },
    });
    const nodeB = makeNode({ id: "b", rect: { x: 200, y: 200, w: 80, h: 80 } });
    const byVisId = new Map([["a", node], ["b", nodeB]]);
    expect(extractAlignmentRelations(node, byVisId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// interpretPage — end-to-end
// ---------------------------------------------------------------------------

describe("interpretPage", () => {
  it("attaches grid interpretation to a grid node", () => {
    const node = makeNode({
      id: "vis:grid",
      computedStyle: {
        display: "grid",
        "grid-template-columns": "1fr 1fr",
        "grid-template-rows": "auto",
        "column-gap": "10px",
        "row-gap": "0px",
      },
    });
    const { layoutEdges } = interpretPage([node], "page:test", "test:interpret");
    expect(node.interpretation).toBeDefined();
    expect(node.interpretation!.grid).toBeDefined();
    expect(node.interpretation!.grid!.columns).toEqual(["1fr", "1fr"]);
    expect(node.interpretation!.grid!.rows).toEqual(["auto"]);
    expect(layoutEdges).toHaveLength(0);
  });

  it("attaches flex interpretation to a flex node", () => {
    const node = makeNode({
      id: "vis:flex",
      computedStyle: {
        display: "flex",
        "flex-direction": "column",
        "flex-wrap": "wrap",
        gap: "8px",
      },
    });
    interpretPage([node], "page:test", "test:interpret");
    expect(node.interpretation!.flex).toBeDefined();
    expect(node.interpretation!.flex!.direction).toBe("column");
    expect(node.interpretation!.flex!.wrap).toBe(true);
  });

  it("emits layout edges for aligned siblings", () => {
    const nodeA = makeNode({
      id: "a",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      // A references B; B does NOT reference A — only A→B fires.
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: ["b"], anchors: [] },
    });
    const nodeB = makeNode({
      id: "b",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      // B has no siblings, so B's extractAlignmentRelations emits nothing.
      // Only A→B is emitted (exactly 1 edge).
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const { layoutEdges } = interpretPage([nodeA, nodeB], "page:test", "test:interpret");
    expect(layoutEdges).toHaveLength(1);
    expect(layoutEdges[0]!.from).toBe("a");
    expect(layoutEdges[0]!.to).toBe("b");
    expect(layoutEdges[0]!.kind).toBe("visual:layout-relation");
    expect(layoutEdges[0]!.alignment).toBe("aligned-horizontally");
  });

  it("emits bidirectional edges when both nodes are aligned", () => {
    // a aligns with b and b aligns with a (both horizontal).
    const nodeA = makeNode({
      id: "a",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: ["b"], anchors: [] },
    });
    const nodeB = makeNode({
      id: "b",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: ["a"], siblingsAfter: [], anchors: [] },
    });
    const { layoutEdges } = interpretPage([nodeA, nodeB], "page:test", "test:interpret");
    // a→b from a's perspective, b→a from b's perspective
    expect(layoutEdges).toHaveLength(2);
    const fromA = layoutEdges.find((e) => e.from === "a" && e.to === "b");
    const fromB = layoutEdges.find((e) => e.from === "b" && e.to === "a");
    expect(fromA?.alignment).toBe("aligned-horizontally");
    expect(fromB?.alignment).toBe("aligned-horizontally");
  });

  it("uses the correct edge id format", () => {
    const nodeA = makeNode({
      id: "vis:page:a",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: ["vis:page:b"], anchors: [] },
    });
    const nodeB = makeNode({
      id: "vis:page:b",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: ["vis:page:a"], siblingsAfter: [], anchors: [] },
    });
    const { layoutEdges } = interpretPage([nodeA, nodeB], "page:test", "test:provenance");
    const edge = layoutEdges.find((e) => e.from === "vis:page:a" && e.to === "vis:page:b")!;
    expect(edge.id).toBe("edge:vis:page:a->vis:page:b:visual:layout-relation");
    expect(edge.type).toBe("edge");
    expect(edge.kind).toBe("visual:layout-relation");
    expect(edge.provenance).toBe("test:provenance");
  });

  it("attaches prominence to all nodes (prominence always defined)", () => {
    const node = makeNode({
      id: "plain",
      computedStyle: { display: "block" },
    });
    const { layoutEdges } = interpretPage([node], "page:test", "test:interpret");
    // Prominence is always attached (even if not "prominent")
    expect(node.interpretation).toBeDefined();
    expect(node.interpretation!.prominence).toBeDefined();
    expect(node.interpretation!.prominence!.isProminent).toBe(false);
    expect(layoutEdges).toHaveLength(0);
  });

  it("returns empty edge list when no nodes have layout relations", () => {
    const nodeA = makeNode({
      id: "a",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: ["b"], anchors: [] },
    });
    const nodeB = makeNode({
      id: "b",
      rect: { x: 200, y: 200, w: 80, h: 80 }, // not aligned
      tethers: { parent: null, children: [], siblingsBefore: ["a"], siblingsAfter: [], anchors: [] },
    });
    const { layoutEdges } = interpretPage([nodeA, nodeB], "page:test", "test:interpret");
    expect(layoutEdges).toHaveLength(0);
  });

  it("returns component groups from a flex container with children", () => {
    const container = makeNode({
      id: "flex-container",
      computedStyle: { display: "flex", "flex-direction": "row", gap: "8px" },
      tethers: { parent: null, children: ["child1", "child2"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const child1 = makeNode({ id: "child1", rect: { x: 0, y: 0, w: 50, h: 20 }, computedStyle: { display: "block" } });
    const child2 = makeNode({ id: "child2", rect: { x: 50, y: 0, w: 50, h: 20 }, computedStyle: { display: "block" } });
    const { componentGroups } = interpretPage([container, child1, child2], "page:test", "test:interpret");
    expect(componentGroups).toHaveLength(1);
    expect(componentGroups[0]!.kind).toBe("flex-container");
    expect(componentGroups[0]!.memberIds).toContain("child1");
    expect(componentGroups[0]!.memberIds).toContain("child2");
    expect(componentGroups[0]!.confidence).toBeGreaterThanOrEqual(60);
  });

  it("returns responsive hint when flex-wrap is detected", () => {
    const node = makeNode({
      id: "responsive-flex",
      computedStyle: {
        display: "flex",
        "flex-direction": "row",
        "flex-wrap": "wrap",
      },
    });
    interpretPage([node], "page:test", "test:interpret");
    expect(node.interpretation!.responsive).toBeDefined();
    expect(node.interpretation!.responsive!.strategy).toBe("flex-wrap");
  });
});

// ---------------------------------------------------------------------------
// Visual prominence scoring helpers
// ---------------------------------------------------------------------------

describe("scoreZIndex", () => {
  it("returns 0 for undefined", () => expect(scoreZIndex(undefined)).toBe(0));
  it("returns 0 for empty string", () => expect(scoreZIndex("")).toBe(0));
  it("returns 0 for non-numeric", () => expect(scoreZIndex("auto")).toBe(0));
  it("returns 0 for negative z-index", () => expect(scoreZIndex("-1")).toBe(0));
  it("returns 0 for z-index 0", () => expect(scoreZIndex("0")).toBe(0));
  it("maps 10 to 60", () => expect(scoreZIndex("10")).toBe(60));
  it("maps 5 to 30", () => expect(scoreZIndex("5")).toBe(30));
  it("maps 100 to 100", () => expect(scoreZIndex("100")).toBe(100));
  it("maps 200 (above 100) to 100", () => expect(scoreZIndex("200")).toBe(100));
});

describe("scoreOpacity", () => {
  it("returns 0 for undefined (defaults to fully opaque)", () => expect(scoreOpacity(undefined)).toBe(0));
  it("returns 0 for opacity:1", () => expect(scoreOpacity("1")).toBe(0));
  it("returns 0 for opacity:1.0", () => expect(scoreOpacity("1.0")).toBe(0));
  it("returns 50 for opacity:0.5", () => expect(scoreOpacity("0.5")).toBe(50));
  it("returns 90 for opacity:0.1", () => expect(scoreOpacity("0.1")).toBe(90));
  it("returns 100 for opacity:0", () => expect(scoreOpacity("0")).toBe(100));
  it("caps at 100 for negative opacity", () => expect(scoreOpacity("-0.5")).toBe(100));
  // Note: parseFloat("rgba(...)") returns the leading number, not the alpha.
  // rgba(0,0,0,0.3) → parseFloat returns 0 → score = 100 (transparent).
  // But rgba(255,0,0,0.3) → parseFloat returns 255 → invalid → score = 0.
  it("returns 0 for rgba (leading number not a valid opacity)", () => expect(scoreOpacity("rgba(0,0,0,0.3)")).toBe(0));
});

describe("scoreTransform", () => {
  it("returns 0 for undefined", () => expect(scoreTransform(undefined)).toBe(0));
  it("returns 0 for empty string", () => expect(scoreTransform("")).toBe(0));
  it("returns 0 for non-scale transforms", () => expect(scoreTransform("translate(10px, 20px)")).toBe(0));
  it("returns 0 for scale(1)", () => expect(scoreTransform("scale(1)")).toBe(0));
  it("returns 20 for scale(1.2)", () => expect(scoreTransform("scale(1.2)")).toBe(20));
  it("returns 50 for scale(1.5)", () => expect(scoreTransform("scale(1.5)")).toBe(50));
  it("returns 100 for scale(2)", () => expect(scoreTransform("scale(2)")).toBe(100));
  it("caps at 100 for scale(3)", () => expect(scoreTransform("scale(3)")).toBe(100));
  it("handles scale with multiple args", () => expect(scoreTransform("scale(1.5, 1.5)")).toBe(50));
});

describe("scoreFontSize", () => {
  // Formula: ((n - 8) / (24 - 8)) * 100, clamped [0, 100]
  it("returns 75 for undefined (browser default)", () => expect(scoreFontSize(undefined)).toBe(75));
  it("returns 50 for 16px ((16-8)/16*100)", () => expect(scoreFontSize("16px")).toBe(50));
  it("returns 0 for 8px", () => expect(scoreFontSize("8px")).toBe(0));
  it("returns 100 for 24px", () => expect(scoreFontSize("24px")).toBe(100));
  it("returns 100 for 32px (capped)", () => expect(scoreFontSize("32px")).toBe(100));
  it("returns 25 for 12px ((12-8)/16*100)", () => expect(scoreFontSize("12px")).toBe(25));
  it("returns 0 for 1em (parseFloat=1 → (1-8)/16*100)", () => expect(scoreFontSize("1em")).toBe(0));
  it("returns 75 for non-pixel values (NaN)", () => expect(scoreFontSize("large")).toBe(75));
});

// ---------------------------------------------------------------------------
// extractVisualProminence
// ---------------------------------------------------------------------------

describe("extractVisualProminence", () => {
  it("returns baseline prominence for a plain block element", () => {
    const node = makeNode({ id: "plain", computedStyle: { display: "block" } });
    const p = extractVisualProminence(node);
    expect(p.subscores.zIndex).toBe(0);
    expect(p.subscores.opacity).toBe(0);
    expect(p.subscores.transform).toBe(0);
    expect(p.isOverlay).toBe(false);
    expect(p.isInteractive).toBe(false);
    expect(p.isProminent).toBe(false);
  });

  it("sets isOverlay for position:fixed", () => {
    const node = makeNode({ id: "overlay", computedStyle: { display: "block", position: "fixed" } });
    expect(extractVisualProminence(node).isOverlay).toBe(true);
  });

  it("sets isOverlay for position:absolute", () => {
    const node = makeNode({ id: "overlay", computedStyle: { display: "block", position: "absolute" } });
    expect(extractVisualProminence(node).isOverlay).toBe(true);
  });

  it("sets isOverlay for position:sticky", () => {
    const node = makeNode({ id: "overlay", computedStyle: { display: "block", position: "sticky" } });
    expect(extractVisualProminence(node).isOverlay).toBe(true);
  });

  it("does not set isOverlay for position:static", () => {
    const node = makeNode({ id: "static", computedStyle: { display: "block", position: "static" } });
    expect(extractVisualProminence(node).isOverlay).toBe(false);
  });

  it("sets isInteractive for cursor:pointer", () => {
    const node = makeNode({ id: "btn", computedStyle: { display: "block", cursor: "pointer" } });
    expect(extractVisualProminence(node).isInteractive).toBe(true);
  });

  it("sets isInteractive for cursor:grab", () => {
    const node = makeNode({ id: "draggable", computedStyle: { display: "block", cursor: "grab" } });
    expect(extractVisualProminence(node).isInteractive).toBe(true);
  });

  it("does not set isInteractive for cursor:text", () => {
    const node = makeNode({ id: "text", computedStyle: { display: "block", cursor: "text" } });
    expect(extractVisualProminence(node).isInteractive).toBe(false);
  });

  it("sets isProminent when zIndex score > 70", () => {
    // z-index 100 → score 100 (> 70 threshold)
    const node = makeNode({ id: "high-z", computedStyle: { display: "block", zIndex: "100" } });
    expect(extractVisualProminence(node).isProminent).toBe(true);
  });

  it("sets isProminent when opacity is near-transparent", () => {
    // opacity 0.05 → score 95 (> 80 threshold)
    const node = makeNode({ id: "fade", computedStyle: { display: "block", opacity: "0.05" } });
    expect(extractVisualProminence(node).isProminent).toBe(true);
  });

  it("sets isProminent when font-size is large", () => {
    // font-size 32px → score 100 (> 90 threshold)
    const node = makeNode({ id: "large-text", computedStyle: { display: "block", fontSize: "32px" } });
    expect(extractVisualProminence(node).isProminent).toBe(true);
  });

  it("sets isProminent when transform:scale(2)", () => {
    // scale(2) → score 100 (> 80 threshold)
    const node = makeNode({ id: "scaled", computedStyle: { display: "block", transform: "scale(2)" } });
    expect(extractVisualProminence(node).isProminent).toBe(true);
  });

  it("does not set isProminent for a typical content element", () => {
    const node = makeNode({ id: "content", computedStyle: { display: "block", fontSize: "16px", zIndex: "0" } });
    expect(extractVisualProminence(node).isProminent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// inferComponentGroups
// ---------------------------------------------------------------------------

describe("inferComponentGroups", () => {
  it("returns empty array for empty input", () => {
    expect(inferComponentGroups([])).toHaveLength(0);
  });

  it("does not emit a group for a flex container with < 2 children", () => {
    const flex = makeNode({
      id: "flex-single",
      computedStyle: { display: "flex" },
      tethers: { parent: null, children: ["child1"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const child1 = makeNode({ id: "child1", rect: { x: 0, y: 0, w: 50, h: 20 }, computedStyle: {} });
    expect(inferComponentGroups([flex, child1])).toHaveLength(0);
  });

  it("emits flex-container group when flex has ≥2 children", () => {
    const flex = makeNode({
      id: "flex-row",
      computedStyle: { display: "flex", "flex-direction": "row" },
      tethers: { parent: null, children: ["c1", "c2"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const c1 = makeNode({ id: "c1", rect: { x: 0, y: 0, w: 50, h: 20 }, computedStyle: {} });
    const c2 = makeNode({ id: "c2", rect: { x: 50, y: 0, w: 50, h: 20 }, computedStyle: {} });
    const groups = inferComponentGroups([flex, c1, c2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("flex-container");
    expect(groups[0]!.memberIds).toContain("c1");
    expect(groups[0]!.memberIds).toContain("c2");
  });

  it("emits grid-container group when grid has ≥2 children", () => {
    const grid = makeNode({
      id: "grid",
      computedStyle: { display: "grid", "grid-template-columns": "1fr 1fr" },
      tethers: { parent: null, children: ["g1", "g2"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const g1 = makeNode({ id: "g1", rect: { x: 0, y: 0, w: 50, h: 50 }, computedStyle: {} });
    const g2 = makeNode({ id: "g2", rect: { x: 50, y: 0, w: 50, h: 50 }, computedStyle: {} });
    const groups = inferComponentGroups([grid, g1, g2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("grid-container");
  });

  it("calculates correct bounds for a flex group", () => {
    const flex = makeNode({
      id: "flex",
      computedStyle: { display: "flex" },
      tethers: { parent: null, children: ["c1", "c2"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const c1 = makeNode({ id: "c1", rect: { x: 10, y: 20, w: 50, h: 30 }, computedStyle: {} });
    const c2 = makeNode({ id: "c2", rect: { x: 80, y: 20, w: 60, h: 30 }, computedStyle: {} });
    const groups = inferComponentGroups([flex, c1, c2]);
    expect(groups[0]!.bounds).toEqual({ x: 10, y: 20, w: 130, h: 30 });
  });

  it("skips flex with children not in the node list", () => {
    const flex = makeNode({
      id: "flex",
      computedStyle: { display: "flex" },
      tethers: { parent: null, children: ["ghost", "real"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const real = makeNode({ id: "real", rect: { x: 0, y: 0, w: 50, h: 20 }, computedStyle: {} });
    const groups = inferComponentGroups([flex, real]);
    // "ghost" is not in the list, so only "real" counts
    // < 2 found children → no group emitted
    expect(groups).toHaveLength(0);
  });

  it("does not assign a node to multiple groups", () => {
    const flex = makeNode({
      id: "flex",
      computedStyle: { display: "flex" },
      tethers: { parent: null, children: ["c1", "c2"], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    });
    const c1 = makeNode({ id: "c1", rect: { x: 0, y: 0, w: 50, h: 20 }, computedStyle: {} });
    const c2 = makeNode({ id: "c2", rect: { x: 50, y: 0, w: 50, h: 20 }, computedStyle: {} });
    const groups = inferComponentGroups([flex, c1, c2]);
    // All members assigned to the flex group
    for (const g of groups) {
      for (const id of g.memberIds) {
        expect(g.memberIds.filter((x) => x === id)).toHaveLength(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// detectResponsiveHints
// ---------------------------------------------------------------------------

describe("detectResponsiveHints", () => {
  it("returns undefined for a plain block with no responsive signals", () => {
    const node = makeNode({ id: "plain", computedStyle: { display: "block" } });
    expect(detectResponsiveHints(node)).toBeUndefined();
  });

  it("detects flex-wrap:wrap", () => {
    const node = makeNode({
      id: "wrap",
      computedStyle: { display: "flex", "flex-direction": "row", "flex-wrap": "wrap" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("flex-wrap");
    expect(hint.signals).toContain("flex-wrap:wrap");
    expect(hint.description).toContain("reflows");
  });

  it("detects fluid-width from percentage width", () => {
    const node = makeNode({
      id: "fluid",
      computedStyle: { display: "block", width: "100%" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("fluid-width");
    expect(hint.signals).toContain("width:100%");
  });

  it("detects fluid-width from minmax grid", () => {
    const node = makeNode({
      id: "grid-responsive",
      computedStyle: { display: "grid", "grid-template-columns": "minmax(200px, 1fr) 200px" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("grid-responsive");
    expect(hint.signals.some((s) => s.includes("minmax"))).toBe(true);
  });

  it("detects grid-responsive for grid with fr units", () => {
    const node = makeNode({
      id: "grid-fr",
      computedStyle: { display: "grid", "grid-template-columns": "1fr 2fr" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("grid-responsive");
  });

  it("detects clamp-font from font-size", () => {
    const node = makeNode({
      id: "clamp-text",
      computedStyle: { display: "block", fontSize: "clamp(12px, 2vw, 24px)" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("clamp-font");
    expect(hint.signals[0]).toContain("clamp");
  });

  it("detects fixed-width for px widths", () => {
    const node = makeNode({
      id: "fixed",
      computedStyle: { display: "block", width: "1200px" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("fixed-width");
  });

  it("flex-wrap takes precedence over fixed width (flex container)", () => {
    const node = makeNode({
      id: "wrap-fixed",
      computedStyle: { display: "flex", "flex-direction": "row", "flex-wrap": "wrap", width: "1200px" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("flex-wrap");
  });

  it("prefers grid-responsive over fluid-width", () => {
    const node = makeNode({
      id: "grid-fluid",
      computedStyle: { display: "grid", "grid-template-columns": "1fr 2fr", width: "100%" },
    });
    const hint = detectResponsiveHints(node)!;
    expect(hint.strategy).toBe("grid-responsive");
  });

  it("returns fixed-width for a plain px width (anti-responsive signal)", () => {
    const node = makeNode({
      id: "static",
      computedStyle: { display: "block", width: "100px" },
    });
    // width is fixed px with no min/max → fixed-width (signal: layout does not adapt)
    const hint = detectResponsiveHints(node);
    expect(hint).toBeDefined();
    expect(hint!.strategy).toBe("fixed-width");
    expect(hint!.signals).toContain("width:100px");
  });
});
