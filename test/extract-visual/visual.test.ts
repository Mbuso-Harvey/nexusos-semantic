/**
 * Tests for the visual-layer extractor (plan 6).
 *
 * Mocks `Page.script.callFunction` to return synthetic rects + computed
 * styles for a small DOM and verifies the pure pieces of the extractor:
 *   1. computeTethers picks DOM-parent as primary parent for static elements.
 *   2. computeTethers walks up to the nearest non-static ancestor for
 *      `position: absolute`.
 *   3. Sibling order is by `rect.y` then `rect.x`.
 *   4. Anchor resolution: A's `anchor-name: foo` is resolvable from B's
 *      `position-anchor: foo`.
 *   5. Token reverse-mapping: a value `#0064c8` in a visual node's color
 *      matches a token of the same value, and designTokenRefs contains
 *      the DTCG name.
 *   6. The visualExtractor integration: walker -> token walker -> tethers
 *      -> upsertVisual -> upsertToken.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  visualExtractor,
  computeTethers,
  matchTokenRefs,
  kebabToDtcg,
  rgbToHex,
  guessDtcgType,
  type VisualElementRaw,
} from "../../src/extract-visual/visual.js";
import { Graph } from "../../src/graph/graph.js";
import type { ExtractorContext } from "../../src/crawler/orchestrator.js";
import type { PageNode } from "../../src/graph/types.js";

const PAGE_ID = "page:https://example.com/";

function makePageNode(): PageNode {
  return {
    id: PAGE_ID,
    type: "page",
    url: "https://example.com/",
    title: "Test",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: "https://example.com/",
    crawledAt: new Date(0).toISOString(), parentPageId: null,
  };
}

/** Build a minimal element with sane defaults. */
function el(over: Partial<VisualElementRaw> & { axId: string; parentAxId?: string | null }): VisualElementRaw {
  return {
    domOrder: 0,
    tag: "div",
    elementId: null,
    rect: { x: 0, y: 0, w: 100, h: 50 },
    computedStyle: {
      display: "block", position: "static",
      color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)",
      fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400",
      borderRadius: "0px", padding: "0px", margin: "0px",
    },
    customProperties: [],
    parentAxId: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("kebabToDtcg", () => {
  it("strips leading -- and converts kebab to dot path", () => {
    expect(kebabToDtcg("--color-accent")).toBe("color.accent");
    expect(kebabToDtcg("--space-1")).toBe("space.1");
    expect(kebabToDtcg("--font-size-md")).toBe("font.size.md");
  });
});

describe("rgbToHex", () => {
  it("converts rgb() to lowercase hex", () => {
    expect(rgbToHex("rgb(0, 100, 200)")).toBe("#0064c8");
    expect(rgbToHex("rgb(255, 255, 255)")).toBe("#ffffff");
  });
  it("normalizes an already-hex value to lowercase", () => {
    expect(rgbToHex("#0064C8")).toBe("#0064c8");
  });
  it("returns null for non-color strings", () => {
    expect(rgbToHex("16px")).toBe(null);
    expect(rgbToHex("sans-serif")).toBe(null);
  });
  it("clamps out-of-range channel values", () => {
    expect(rgbToHex("rgb(300, -10, 100)")).toBe("#ff0064");
  });
});

describe("guessDtcgType", () => {
  it("detects hex colors as color", () => {
    expect(guessDtcgType("#ffffff")).toBe("color");
  });
  it("detects rgb() as color", () => {
    expect(guessDtcgType("rgb(0, 0, 0)")).toBe("color");
  });
  it("detects px/rem/% units as dimension", () => {
    expect(guessDtcgType("4px")).toBe("dimension");
    expect(guessDtcgType("1.5rem")).toBe("dimension");
    expect(guessDtcgType("50%")).toBe("dimension");
  });
  it("returns string for plain identifiers", () => {
    expect(guessDtcgType("sans-serif")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// computeTethers — Step 1: static-positioned elements use DOM parent
// ---------------------------------------------------------------------------

describe("computeTethers — DOM parent for static-positioned elements", () => {
  it("uses the DOM parent directly for static elements", () => {
    // Tree: nav -> [a, button] where a, button, and nav are all static.
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:nav", parentAxId: null, computedStyle: { position: "static", display: "block" } }),
      el({ axId: "ax:a", parentAxId: "ax:nav", computedStyle: { position: "static", display: "inline" } }),
      el({ axId: "ax:btn", parentAxId: "ax:nav", computedStyle: { position: "static", display: "inline-block" } }),
    ];
    const tethers = computeTethers(elements);
    expect(tethers.get("ax:nav")!.parent).toBe(null);
    expect(tethers.get("ax:a")!.parent).toBe("ax:nav");
    expect(tethers.get("ax:btn")!.parent).toBe("ax:nav");
  });
});

// ---------------------------------------------------------------------------
// computeTethers — Step 2: absolute/fixed/sticky walks up to nearest non-static
// ---------------------------------------------------------------------------

describe("computeTethers — absolute walks up to nearest non-static ancestor", () => {
  it("for position: absolute, walks up DOM parent chain to the nearest non-static ancestor", () => {
    // Tree:
    //   section (static)
    //     div (static)
    //       article (position: relative)  <- layout parent
    //         badge (position: absolute)
    //   aside (position: relative)        <- unrelated branch
    //
    // Expected: badge.parent = article (the nearest non-static ancestor).
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:section", parentAxId: null, computedStyle: { position: "static" } }),
      el({ axId: "ax:div", parentAxId: "ax:section", computedStyle: { position: "static" } }),
      el({ axId: "ax:article", parentAxId: "ax:div", computedStyle: { position: "relative" } }),
      el({ axId: "ax:badge", parentAxId: "ax:article", computedStyle: { position: "absolute" } }),
      el({ axId: "ax:aside", parentAxId: null, computedStyle: { position: "relative" } }),
    ];
    const tethers = computeTethers(elements);
    expect(tethers.get("ax:badge")!.parent).toBe("ax:article");
  });

  it("for position: fixed with no non-static ancestor, layout parent is null (viewport)", () => {
    // Tree: body (static) -> dialog (fixed)
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:body", parentAxId: null, computedStyle: { position: "static" } }),
      el({ axId: "ax:dialog", parentAxId: "ax:body", computedStyle: { position: "fixed" } }),
    ];
    const tethers = computeTethers(elements);
    expect(tethers.get("ax:dialog")!.parent).toBe(null);
  });

  it("for position: sticky, layout parent is the nearest non-static ancestor", () => {
    // Tree:
    //   main (static)
    //     header (position: sticky)
    //     content (static)
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:main", parentAxId: null, computedStyle: { position: "static" } }),
      el({ axId: "ax:header", parentAxId: "ax:main", computedStyle: { position: "sticky" } }),
      el({ axId: "ax:content", parentAxId: "ax:main", computedStyle: { position: "static" } }),
    ];
    const tethers = computeTethers(elements);
    // No non-static ancestor; layout parent is null (viewport).
    expect(tethers.get("ax:header")!.parent).toBe(null);
  });

  it("children of an absolute-positioned element include its absolutely-positioned descendants", () => {
    // Tree:
    //   card (position: relative)
    //     text (static)              <- DOM child
    //     tooltip (position: absolute) <- absolutely-positioned descendant whose layout parent is card
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:card", parentAxId: null, computedStyle: { position: "relative" } }),
      el({ axId: "ax:text", parentAxId: "ax:card", computedStyle: { position: "static" } }),
      // For the absolutely-positioned tooltip, its DOM parent is text but its
      // layout parent is card.
      el({ axId: "ax:tooltip", parentAxId: "ax:text", computedStyle: { position: "absolute" } }),
    ];
    const tethers = computeTethers(elements);
    // text.layoutParent = card (DOM parent)
    expect(tethers.get("ax:text")!.parent).toBe("ax:card");
    // tooltip.layoutParent = card (walks up past text which is static)
    expect(tethers.get("ax:tooltip")!.parent).toBe("ax:card");
    // card.children should include BOTH text and tooltip.
    expect(new Set(tethers.get("ax:card")!.children)).toEqual(new Set(["ax:text", "ax:tooltip"]));
  });
});

// ---------------------------------------------------------------------------
// computeTethers — Step 4: sibling order by rect.y then rect.x
// ---------------------------------------------------------------------------

describe("computeTethers — sibling order by rect.y then rect.x", () => {
  it("orders siblings by y ascending, then x ascending", () => {
    // Three static siblings under main with explicit positions.
    // y=20, x=10   -> "ax:third" (visually first)
    // y=20, x=200  -> "ax:first"
    // y=100, x=5   -> "ax:second"
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:main", parentAxId: null, rect: { x: 0, y: 0, w: 1000, h: 1000 } }),
      el({ axId: "ax:first", parentAxId: "ax:main", rect: { x: 200, y: 20, w: 50, h: 30 } }),
      el({ axId: "ax:second", parentAxId: "ax:main", rect: { x: 5, y: 100, w: 50, h: 30 } }),
      el({ axId: "ax:third", parentAxId: "ax:main", rect: { x: 10, y: 20, w: 50, h: 30 } }),
    ];
    const tethers = computeTethers(elements);
    // Sorted by (y, x): third (y=20, x=10), first (y=20, x=200), second (y=100, x=5).
    // So:
    //   third: before=[],   after=[first, second]
    //   first: before=[third], after=[second]
    //   second: before=[third, first], after=[]
    expect(tethers.get("ax:third")!.siblingsBefore).toEqual([]);
    expect(tethers.get("ax:third")!.siblingsAfter).toEqual(["ax:first", "ax:second"]);
    expect(tethers.get("ax:first")!.siblingsBefore).toEqual(["ax:third"]);
    expect(tethers.get("ax:first")!.siblingsAfter).toEqual(["ax:second"]);
    expect(tethers.get("ax:second")!.siblingsBefore).toEqual(["ax:third", "ax:first"]);
    expect(tethers.get("ax:second")!.siblingsAfter).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeTethers — Step 5: anchor resolution
// ---------------------------------------------------------------------------

describe("computeTethers — anchor resolution", () => {
  it("A's anchor-name: foo resolves from B's position-anchor: foo", () => {
    // A: a heading with anchor-name: foo.
    // B: a tooltip with position-anchor: foo. The test asserts that B's
    // tethers.anchors contains {name: "foo", target: A.axId}.
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:A", parentAxId: null, computedStyle: { position: "static", "anchor-name": "foo" } }),
      el({ axId: "ax:B", parentAxId: "ax:A", computedStyle: { position: "fixed", "position-anchor": "foo" } }),
    ];
    const tethers = computeTethers(elements);
    expect(tethers.get("ax:B")!.anchors).toEqual([{ name: "foo", target: "ax:A" }]);
  });

  it("an unresolved position-anchor is omitted (not emitted with null target)", () => {
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:trigger", parentAxId: null, computedStyle: { position: "fixed", "position-anchor": "nope" } }),
    ];
    const tethers = computeTethers(elements);
    expect(tethers.get("ax:trigger")!.anchors).toEqual([]);
  });

  it("supports multiple comma-separated anchor-name and position-anchor values", () => {
    const elements: VisualElementRaw[] = [
      el({ axId: "ax:A", parentAxId: null, computedStyle: { "anchor-name": "foo, bar" } }),
      el({ axId: "ax:B", parentAxId: "ax:A", computedStyle: { "position-anchor": "foo, baz" } }),
    ];
    const tethers = computeTethers(elements);
    // foo resolves to A, baz does not.
    expect(tethers.get("ax:B")!.anchors).toEqual([{ name: "foo", target: "ax:A" }]);
  });
});

// ---------------------------------------------------------------------------
// matchTokenRefs — plan 6.3
// ---------------------------------------------------------------------------

describe("matchTokenRefs — token reverse-mapping", () => {
  it("matches a value #0064c8 in color to a token with the same value", () => {
    const tokenIndex = new Map<string, { raw: string; hex: string | null }>();
    tokenIndex.set("color.accent", { raw: "#0064c8", hex: "#0064c8" });
    const refs = matchTokenRefs({ color: "#0064c8" }, tokenIndex);
    expect(refs).toEqual(["color.accent"]);
  });

  it("matches rgb(...) to a token with the equivalent hex value", () => {
    const tokenIndex = new Map<string, { raw: string; hex: string | null }>();
    tokenIndex.set("color.accent", { raw: "#0064c8", hex: "#0064c8" });
    const refs = matchTokenRefs({ color: "rgb(0, 100, 200)" }, tokenIndex);
    expect(refs).toEqual(["color.accent"]);
  });

  it("returns empty when no token matches", () => {
    const tokenIndex = new Map<string, { raw: string; hex: string | null }>();
    tokenIndex.set("color.bg", { raw: "#ffffff", hex: "#ffffff" });
    const refs = matchTokenRefs({ color: "#000000" }, tokenIndex);
    expect(refs).toEqual([]);
  });

  it("de-duplicates tokens that match across multiple properties", () => {
    const tokenIndex = new Map<string, { raw: string; hex: string | null }>();
    tokenIndex.set("color.bg", { raw: "#ffffff", hex: "#ffffff" });
    // Both color and background-color happen to be #ffffff.
    const refs = matchTokenRefs({ color: "#ffffff", backgroundColor: "#ffffff" }, tokenIndex);
    expect(refs).toEqual(["color.bg"]);
  });

  it("skips null/empty property values", () => {
    const tokenIndex = new Map<string, { raw: string; hex: string | null }>();
    tokenIndex.set("color.accent", { raw: "#0064c8", hex: "#0064c8" });
    const refs = matchTokenRefs(
      { color: undefined, backgroundColor: "" },
      tokenIndex,
    );
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// visualExtractor — end-to-end with mocked page
// ---------------------------------------------------------------------------

describe("visualExtractor — integration with mocked page", () => {
  let graph: Graph;
  let log: ReturnType<typeof vi.fn>;
  let callFunction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    graph = new Graph();
    graph.upsertPage(makePageNode());
    log = vi.fn();
    callFunction = vi.fn();
  });

  it("writes visual nodes, computes tethers, and reverse-maps design tokens", async () => {
    // Synthetic walk result: two elements — a static section and a button
    // whose color matches a token. Plus the token walker returns a single
    // --color-accent token.
    const walkResult = {
      elements: [
        {
          domOrder: 0,
          tag: "section",
          elementId: null,
          axId: `ax:${PAGE_ID}:n0`,
          parentAxId: null,
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          computedStyle: {
            display: "block", position: "static",
            color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)",
            "font-size": "16px",
          },
          customProperties: [],
        },
        {
          domOrder: 1,
          tag: "button",
          elementId: null,
          axId: `ax:${PAGE_ID}:n1`,
          parentAxId: `ax:${PAGE_ID}:n0`,
          rect: { x: 10, y: 10, w: 100, h: 40 },
          computedStyle: {
            display: "inline-block", position: "static",
            color: "#0064c8", backgroundColor: "#ffffff",
            "font-size": "14px",
          },
          customProperties: [],
        },
      ],
      rootCustomProperties: [],
    };
    const tokens = [{ name: "--color-accent", value: "#0064c8" }];

    callFunction.mockImplementation(async (_t: any, src: string) => {
      if (src.includes("styleSheets")) return tokens;
      return walkResult;
    });

    const page = {
      target: { context: "ctx" },
      script: { callFunction },
    };
    const ctx = {
      graph, page: page as any, pageNode: graph.getPage(PAGE_ID)!,
      budget: { maxPages: 1, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
      log,
    } as ExtractorContext;

    const r = await visualExtractor.run(ctx);
    expect(callFunction).toHaveBeenCalled();
    expect(r.produced).toBe(true);

    // 2 visual nodes written.
    expect(graph.visualCount).toBe(2);
    // 1 token written.
    expect(graph.tokenCount).toBe(1);
    expect(graph.getToken("color.accent")?.$value).toBe("#0064c8");

    // Button visual node has the token reference.
    const button = graph.visualByAx(`ax:${PAGE_ID}:n1`);
    expect(button).toBeDefined();
    expect(button!.designTokenRefs).toContain("color.accent");
    expect(button!.tethers.parent).toBe(`ax:${PAGE_ID}:n0`);

    // Section has the button as a child.
    const section = graph.visualByAx(`ax:${PAGE_ID}:n0`);
    expect(section!.tethers.children).toContain(`ax:${PAGE_ID}:n1`);

    // Log line per the spec.
    const logged = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toMatch(/\[visual\] nodes=2 tokens=1/);
  });

  it("returns produced=false when the page has no visual elements", async () => {
    callFunction.mockImplementation(async (_t: any, src: string) => {
      if (src.includes("styleSheets")) return [];
      return { elements: [], rootCustomProperties: [] };
    });
    const ctx = {
      graph,
      page: { target: { context: "ctx" }, script: { callFunction } } as any,
      pageNode: graph.getPage(PAGE_ID)!,
      budget: { maxPages: 1, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
      log,
    } as ExtractorContext;
    const r = await visualExtractor.run(ctx);
    expect(r.produced).toBe(false);
    expect(graph.visualCount).toBe(0);
  });

  it("token walker picks up --color-accent with computed value, and the button visual node references it", async () => {
    // Bigger mix: a button whose color is `rgb(0, 100, 200)` and a token
    // with raw value `#0064c8`. The matcher should pick this up via the
    // rgb-to-hex path.
    const walkResult = {
      elements: [
        {
          domOrder: 0,
          tag: "button",
          elementId: "primary",
          axId: `ax:${PAGE_ID}:primary`,
          parentAxId: null,
          rect: { x: 0, y: 0, w: 100, h: 40 },
          computedStyle: {
            display: "inline-block", position: "static",
            color: "rgb(0, 100, 200)",
          },
          customProperties: [],
        },
      ],
      rootCustomProperties: [],
    };
    const tokens = [{ name: "--color-accent", value: "#0064c8" }];
    callFunction.mockImplementation(async (_t: any, src: string) => {
      if (src.includes("styleSheets")) return tokens;
      return walkResult;
    });
    const ctx = {
      graph,
      page: { target: { context: "ctx" }, script: { callFunction } } as any,
      pageNode: graph.getPage(PAGE_ID)!,
      budget: { maxPages: 1, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
      log,
    } as ExtractorContext;
    await visualExtractor.run(ctx);
    const button = graph.visualByAx(`ax:${PAGE_ID}:primary`);
    expect(button).toBeDefined();
    expect(button!.designTokenRefs).toContain("color.accent");
  });
});
