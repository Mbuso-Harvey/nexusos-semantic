/**
 * VI-04: Semantic visual pattern recognition and layout mutation tests.
 */
import { describe, it, expect } from "vitest";
import {
  classifyNodeVisualPatterns,
  classifyPageVisualPatterns,
  classifyLayoutMutation,
  computePageLayoutMutations,
} from "../../src/extract-visual/patterns.js";
import type { AxNode, VisualNode, ViewportObservation, ViewportProfile } from "../../src/graph/types.js";

function makeVisualNode(id: string, axId: string, rect: { x: number; y: number; w: number; h: number }, style: Record<string, string> = {}): VisualNode {
  return {
    id,
    type: "visual-node",
    axId,
    pageId: "page:test",
    rect,
    computedStyle: style,
    designTokenRefs: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.callFunction",
  };
}

function makeAxNode(id: string, role: string, name: string = "", extra: Partial<AxNode> = {}): AxNode {
  return {
    id,
    type: "ax-node",
    pageId: "page:test",
    role: role as any,
    name,
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
    provenance: "bidi:script.callFunction",
    ...extra,
  };
}

describe("VI-04: Semantic visual pattern recognition", () => {
  const vp = { w: 1440, h: 900 };

  it("detects Floating Action Button (fab)", () => {
    const vis = makeVisualNode("vis:fab", "ax:fab", { x: 1360, y: 820, w: 56, h: 56 }, {
      position: "fixed",
      "z-index": "100",
      "border-radius": "50%",
      "box-shadow": "0 4px 10px rgba(0,0,0,0.3)",
      cursor: "pointer",
    });
    const ax = makeAxNode("ax:fab", "button", "New Message");

    const patterns = classifyNodeVisualPatterns(vis, ax, vp);
    expect(patterns.some((p) => p.pattern === "fab")).toBe(true);
    const fabPattern = patterns.find((p) => p.pattern === "fab");
    expect(fabPattern?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(fabPattern?.reasons.some((r) => r.includes("position:fixed"))).toBe(true);
  });

  it("detects modal backdrop", () => {
    const vis = makeVisualNode("vis:backdrop", "ax:backdrop", { x: 0, y: 0, w: 1440, h: 900 }, {
      position: "fixed",
      "z-index": "1000",
      "background-color": "rgba(0, 0, 0, 0.6)",
    });
    const ax = makeAxNode("ax:backdrop", "generic");

    const patterns = classifyNodeVisualPatterns(vis, ax, vp);
    expect(patterns.some((p) => p.pattern === "modal-backdrop")).toBe(true);
    const backdropPattern = patterns.find((p) => p.pattern === "modal-backdrop");
    expect(backdropPattern?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("detects dialog overlay", () => {
    const vis = makeVisualNode("vis:dlg", "ax:dlg", { x: 470, y: 250, w: 500, h: 400 }, {
      position: "fixed",
      "z-index": "1001",
      "box-shadow": "0 8px 30px rgba(0,0,0,0.2)",
    });
    const ax = makeAxNode("ax:dlg", "dialog", "Edit Profile");

    const patterns = classifyNodeVisualPatterns(vis, ax, vp);
    expect(patterns.some((p) => p.pattern === "dialog-overlay")).toBe(true);
  });

  it("detects sticky header and sticky footer", () => {
    const headerVis = makeVisualNode("vis:hdr", "ax:hdr", { x: 0, y: 0, w: 1440, h: 64 }, {
      position: "sticky",
      "z-index": "50",
    });
    const headerAx = makeAxNode("ax:hdr", "banner");

    const footerVis = makeVisualNode("vis:ftr", "ax:ftr", { x: 0, y: 850, w: 1440, h: 50 }, {
      position: "fixed",
      "z-index": "40",
    });
    const footerAx = makeAxNode("ax:ftr", "contentinfo");

    const headerPatterns = classifyNodeVisualPatterns(headerVis, headerAx, vp);
    expect(headerPatterns.some((p) => p.pattern === "sticky-header")).toBe(true);

    const footerPatterns = classifyNodeVisualPatterns(footerVis, footerAx, vp);
    expect(footerPatterns.some((p) => p.pattern === "sticky-footer")).toBe(true);
  });

  it("detects dismiss button by name and dialog corner placement", () => {
    const closeVis = makeVisualNode("vis:close", "ax:close", { x: 920, y: 260, w: 32, h: 32 }, {
      position: "absolute",
      cursor: "pointer",
    });
    const closeAx = makeAxNode("ax:close", "button", "Close");

    const patterns = classifyNodeVisualPatterns(closeVis, closeAx, vp);
    expect(patterns.some((p) => p.pattern === "dismiss-button")).toBe(true);
  });

  it("detects form group with contained controls", () => {
    const formVis = makeVisualNode("vis:fg", "ax:fg", { x: 100, y: 100, w: 400, h: 120 });
    formVis.containerType = "container";
    const formAx = makeAxNode("ax:fg", "group", "Billing Address");

    const inputVis = makeVisualNode("vis:inp", "ax:inp", { x: 110, y: 140, w: 380, h: 40 }, {
      cursor: "text",
    });

    const all = [formVis, inputVis];
    const patterns = classifyNodeVisualPatterns(formVis, formAx, vp, all);
    expect(patterns.some((p) => p.pattern === "form-group")).toBe(true);
  });

  it("detects toast notification", () => {
    const toastVis = makeVisualNode("vis:toast", "ax:toast", { x: 1050, y: 20, w: 350, h: 60 }, {
      position: "fixed",
      "z-index": "9999",
    });
    const toastAx = makeAxNode("ax:toast", "alert", "Settings saved successfully");

    const patterns = classifyNodeVisualPatterns(toastVis, toastAx, vp);
    expect(patterns.some((p) => p.pattern === "toast-notification")).toBe(true);
  });
});

describe("VI-04: Responsive layout mutation classification", () => {
  const desktopVp: ViewportProfile = { name: "desktop", w: 1440, h: 900, dpr: 1 };
  const mobileVp: ViewportProfile = { name: "mobile", w: 390, h: 844, dpr: 3, isMobile: true };

  function makeObs(vp: ViewportProfile, rect: { x: number; y: number; w: number; h: number }, visibility: "visible" | "hidden" = "visible", style: Record<string, string> = {}): ViewportObservation {
    return {
      viewport: vp,
      rect,
      visibility,
      computedStyle: style,
      crawledAt: new Date().toISOString(),
    };
  }

  it("classifies reflow when dimensions change substantially (>15%)", () => {
    const fromObs = makeObs(desktopVp, { x: 0, y: 0, w: 1200, h: 400 });
    const toObs = makeObs(mobileVp, { x: 0, y: 0, w: 350, h: 600 });

    const mutation = classifyLayoutMutation(fromObs, toObs);
    expect(mutation.type).toBe("reflow");
    expect(mutation.severity).toBe("high");
    expect(mutation.reasons.some((r) => r.includes("Dimension delta"))).toBe(true);
  });

  it("classifies reflow when structural CSS properties shift (e.g. flex-direction)", () => {
    const fromObs = makeObs(desktopVp, { x: 0, y: 0, w: 800, h: 200 }, "visible", { "flex-direction": "row" });
    const toObs = makeObs(mobileVp, { x: 0, y: 0, w: 750, h: 200 }, "visible", { "flex-direction": "column" });

    const mutation = classifyLayoutMutation(fromObs, toObs);
    expect(mutation.type).toBe("reflow");
    expect(mutation.reasons.some((r) => r.includes("flex-direction reflow"))).toBe(true);
  });

  it("classifies hide when element becomes hidden or zero dimension", () => {
    const fromObs = makeObs(desktopVp, { x: 100, y: 50, w: 300, h: 40 });
    const toObs = makeObs(mobileVp, { x: 0, y: 0, w: 0, h: 0 }, "hidden", { display: "none" });

    const mutation = classifyLayoutMutation(fromObs, toObs);
    expect(mutation.type).toBe("hide");
    expect(mutation.severity).toBe("high");
  });

  it("classifies show when element emerges from hidden to visible", () => {
    const fromObs = makeObs(desktopVp, { x: 0, y: 0, w: 0, h: 0 }, "hidden", { display: "none" });
    const toObs = makeObs(mobileVp, { x: 20, y: 20, w: 40, h: 40 }, "visible");

    const mutation = classifyLayoutMutation(fromObs, toObs);
    expect(mutation.type).toBe("show");
    expect(mutation.severity).toBe("high");
  });

  it("classifies reposition when coordinates translate without dimension reflow", () => {
    const fromObs = makeObs(desktopVp, { x: 100, y: 50, w: 200, h: 50 });
    const toObs = makeObs(mobileVp, { x: 120, y: 150, w: 200, h: 50 });

    const mutation = classifyLayoutMutation(fromObs, toObs);
    expect(mutation.type).toBe("reposition");
  });

  it("classifies unchanged when layout and visibility remain stable", () => {
    const fromObs = makeObs(desktopVp, { x: 50, y: 50, w: 200, h: 50 });
    const toObs = makeObs(mobileVp, { x: 50, y: 50, w: 200, h: 50 });

    const mutation = classifyLayoutMutation(fromObs, toObs);
    expect(mutation.type).toBe("unchanged");
    expect(mutation.severity).toBe("none");
  });

  it("computes page layout mutations and synthesizes breakpoint description", () => {
    const elem1 = {
      axId: "ax:hero",
      diff: {} as any,
      mutation: { type: "reflow" as const, reasons: ["resized"], severity: "high" as const },
    };
    const elem2 = {
      axId: "ax:sidebar",
      diff: {} as any,
      mutation: { type: "hide" as const, reasons: ["hidden"], severity: "high" as const },
    };
    const elem3 = {
      axId: "ax:hamburger",
      diff: {} as any,
      mutation: { type: "show" as const, reasons: ["shown"], severity: "high" as const },
    };

    const pageMutations = computePageLayoutMutations("page:home", desktopVp, mobileVp, [elem1, elem2, elem3]);
    expect(pageMutations.summary.reflowCount).toBe(1);
    expect(pageMutations.summary.hideCount).toBe(1);
    expect(pageMutations.summary.showCount).toBe(1);
    expect(pageMutations.breakpointDescription).toContain("desktop(1440px) to mobile(390px)");
    expect(pageMutations.breakpointDescription).toContain("1 reflowed");
    expect(pageMutations.breakpointDescription).toContain("1 hidden");
    expect(pageMutations.breakpointDescription).toContain("1 shown");
  });
});

