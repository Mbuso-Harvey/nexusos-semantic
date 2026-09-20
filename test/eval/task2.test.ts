/**
 * Task 2 tests — primary CTA discovery.
 *
 * Synthetic target: home-page button whose visual node references
 * `color.accent`. GitHub target: button whose name matches
 * /sign\s*up|get\s+started|try\s+github/i.
 */
import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { buildCannedGraph } from "./fixtures/canned-graph.js";
import { task2 } from "../../src/eval/tasks/task2-cta.js";
import type { AxNode, VisualNode, PageNode } from "../../src/graph/types.js";

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

function axBtn(id: string, pageId: string, name: string): AxNode {
  return {
    id, type: "ax-node", pageId, role: "button", name, nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "html:parser",
  };
}

function vis(id: string, pageId: string, axId: string, tokens: string[]): VisualNode {
  return {
    id, type: "visual-node", axId, pageId,
    rect: { x: 0, y: 0, w: 100, h: 40 },
    computedStyle: { backgroundColor: "rgb(0,0,0)" },
    designTokenRefs: tokens,
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.evaluate",
  };
}

describe("task2 — find the primary CTA", () => {
  it("synthetic: returns the home-page button with color.accent in designTokenRefs", async () => {
    const graph = buildCannedGraph();
    const result = await task2({ graph, target: "synthetic" });
    expect(result.ok).toBe(true);
    const row = result.data as { axId: string; name: string; designTokenRefs: string[] };
    expect(row.axId).toBe("ax:new-ticket");
    expect(row.name).toBe("New ticket");
    expect(row.designTokenRefs).toContain("color.accent");
  });

  it("synthetic: ignores buttons whose visual node does NOT reference color.accent", async () => {
    const graph = buildCannedGraph();
    // The canned graph has ax:search-docs with color.muted — make sure it
    // is not picked as the CTA.
    const result = await task2({ graph, target: "synthetic" });
    const row = result.data as { axId: string };
    expect(row.axId).not.toBe("ax:search-docs");
  });

  it("synthetic: returns ok:false when no button has color.accent", async () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(axBtn("ax:btn", "page:/", "Boring"));
    g.upsertVisual(vis("vis:btn", "page:/", "ax:btn", ["color.muted"]));
    const result = await task2({ graph: g, target: "synthetic" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/color\.accent/);
  });

  it("github: matches a button by name pattern /sign up|get started|try github/i", async () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://github.com/"));
    g.upsertAx(axBtn("ax:signup", "page:/", "Sign up for GitHub"));
    g.upsertVisual(vis("vis:signup", "page:/", "ax:signup", []));
    const result = await task2({ graph: g, target: "github" });
    expect(result.ok).toBe(true);
    const row = result.data as { axId: string; name: string };
    expect(row.axId).toBe("ax:signup");
    expect(row.name).toBe("Sign up for GitHub");
  });
});
