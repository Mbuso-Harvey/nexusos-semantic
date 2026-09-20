/**
 * Task 5 tests — find sticky visual nodes and report their tethers.
 */
import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { buildCannedGraph } from "./fixtures/canned-graph.js";
import { task5 } from "../../src/eval/tasks/task5-sticky-headers.js";
import type { AxNode, PageNode, VisualNode } from "../../src/graph/types.js";

function page(id: string, url: string): PageNode {
  return {
    id, type: "page", url, title: url,
    discoveredVia: [], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "html:parser" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: url, crawledAt: new Date(0).toISOString(), parentPageId: null,
  };
}

function axEl(id: string, pageId: string, role: AxNode["role"], name: string): AxNode {
  return {
    id, type: "ax-node", pageId, role, name, nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "html:parser",
  };
}

function vis(id: string, pageId: string, axId: string, position: string, bg?: string): VisualNode {
  return {
    id, type: "visual-node", axId, pageId,
    rect: { x: 0, y: 0, w: 100, h: 56 },
    computedStyle: { position, backgroundColor: bg },
    designTokenRefs: ["color.bg"],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.evaluate",
  };
}

describe("task5 — sticky header discovery", () => {
  it("returns the sticky topbar in the canned graph", async () => {
    const graph = buildCannedGraph();
    const result = await task5({ graph, target: "synthetic" });
    expect(result.ok).toBe(true);
    const rows = result.data as Array<{ visId: string; bgColor: string | null; bgChangeOnScroll: false; bgChangeOnTheme: true }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visId).toBe("vis:topbar");
    expect(rows[0]!.bgColor).toBe("rgb(255, 255, 255)");
    expect(rows[0]!.bgChangeOnScroll).toBe(false);
    expect(rows[0]!.bgChangeOnTheme).toBe(true);
  });

  it("returns ok:false (empty data) when no visual node has position: sticky", async () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(axEl("ax:btn", "page:/", "button", "Submit"));
    g.upsertVisual(vis("vis:btn", "page:/", "ax:btn", "static"));
    const result = await task5({ graph: g, target: "synthetic" });
    expect(result.ok).toBe(false);
    expect(result.data).toEqual([]);
  });

  it("matches multiple sticky visual nodes (multiple pages with sticky elements)", async () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertPage(page("page:/about", "https://example.com/about"));
    g.upsertAx(axEl("ax:topbar1", "page:/", "banner", "Top bar"));
    g.upsertAx(axEl("ax:topbar2", "page:/about", "banner", "Top bar"));
    g.upsertVisual(vis("vis:tb1", "page:/", "ax:topbar1", "sticky"));
    g.upsertVisual(vis("vis:tb2", "page:/about", "ax:topbar2", "sticky"));
    g.upsertVisual(vis("vis:norm", "page:/", "ax:topbar1", "static"));
    const result = await task5({ graph: g, target: "synthetic" });
    const rows = result.data as Array<{ visId: string }>;
    const ids = rows.map((r) => r.visId).sort();
    expect(ids).toEqual(["vis:tb1", "vis:tb2"]);
  });
});
