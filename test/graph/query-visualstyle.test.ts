/**
 * Unit tests for the new `where.visualStyle` predicate (Stage 17, Task 5).
 *
 * Pairs the new query predicate against a hand-built Graph with 3 visual
 * nodes — one sticky, one fixed, one static — and asserts the matcher
 * selects the right one(s) under several filter shapes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { query } from "../../src/graph/query.js";
import type { PageNode, AxNode, VisualNode } from "../../src/graph/types.js";

function page(id: string, url: string): PageNode {
  return {
    id, type: "page", url, title: url,
    discoveredVia: [], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "declared:t" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: url, crawledAt: new Date(0).toISOString(), parentPageId: null,
  };
}

function ax(id: string, pageId: string, role: AxNode["role"], name: string): AxNode {
  return {
    id, type: "ax-node", pageId, role, name, nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
  };
}

function vis(id: string, pageId: string, axId: string, position: string): VisualNode {
  return {
    id, type: "visual-node", axId, pageId,
    rect: { x: 0, y: 0, w: 100, h: 32 },
    computedStyle: { position, display: position === "sticky" ? "block" : "block" },
    designTokenRefs: [], tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:t",
  };
}

describe("query — where.visualStyle predicate", () => {
  let g: Graph;
  beforeEach(() => {
    g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(ax("ax:topbar", "page:/", "banner", "Top bar"));
    g.upsertAx(ax("ax:fab",   "page:/", "button", "Floating action button"));
    g.upsertAx(ax("ax:btn",   "page:/", "button", "Submit"));
    g.upsertVisual(vis("vis:topbar", "page:/", "ax:topbar", "sticky"));
    g.upsertVisual(vis("vis:fab",   "page:/", "ax:fab",   "fixed"));
    g.upsertVisual(vis("vis:btn",   "page:/", "ax:btn",   "static"));
  });

  it("selects only the sticky visual node when filtering position=sticky", () => {
    const res = query(g, { select: "visual-node", where: { visualStyle: { position: "sticky" } } });
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0]!;
    expect(hit.select).toBe("visual-node");
    if (hit.select !== "visual-node") return;
    expect(hit.node.id).toBe("vis:topbar");
  });

  it("selects zero hits when no node has the requested style", () => {
    const res = query(g, { select: "visual-node", where: { visualStyle: { position: "relative" } } });
    expect(res.hits).toHaveLength(0);
  });

  it("AND-combines multiple key/value pairs (position AND display)", () => {
    g.upsertVisual({ ...vis("vis:special", "page:/", "ax:btn", "sticky"), computedStyle: { position: "sticky", display: "grid" } });
    const res = query(g, { select: "visual-node", where: { visualStyle: { position: "sticky", display: "grid" } } });
    expect(res.hits.map((h) => h.node?.id).filter(Boolean)).toEqual(["vis:special"]);
  });

  it("combines with select=any — visualStyle is enforced for visual nodes, no-op for ax nodes", () => {
    // Matches the established pattern: where-clause predicates that only
    // apply to one node kind (like designToken, inTether) are silent no-ops
    // for other kinds. So with select=any, all ax/edge/capability/transition
    // candidates still pass; only visual-node candidates are filtered.
    const res = query(g, { select: "any", where: { visualStyle: { position: "sticky" } } });
    const visualHits = res.hits.filter((h) => h.select === "visual-node");
    expect(visualHits).toHaveLength(1);
    expect(visualHits[0]!.node.id).toBe("vis:topbar");
  });
});
