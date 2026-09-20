/**
 * Task 1 tests — tab discovery via `role: tab` + `aria-controls` edges.
 */
import { describe, it, expect } from "vitest";
import { buildCannedGraph } from "./fixtures/canned-graph.js";
import { task1 } from "../../src/eval/tasks/task1-tabs.js";

describe("task1 — list tabs with their panels", () => {
  it("returns one row per tab on the canned graph", async () => {
    const graph = buildCannedGraph();
    const result = await task1({ graph, target: "synthetic" });
    expect(result.ok).toBe(true);
    const rows = result.data as Array<{ tabAxId: string; tabName: string; panelAxId: string; panelName: string }>;
    expect(rows).toHaveLength(3);
    const names = rows.map((r) => r.tabName).sort();
    expect(names).toEqual(["Archived", "Popular", "Recent"]);
  });

  it("resolves each tab's panel axId via the aria-controls edge", async () => {
    const graph = buildCannedGraph();
    const result = await task1({ graph, target: "synthetic" });
    const rows = result.data as Array<{ tabAxId: string; tabName: string; panelAxId: string; panelName: string }>;
    for (const r of rows) {
      // Each tab is wired to a panel via aria-controls; canned graph wires them.
      expect(r.panelAxId).toMatch(/^ax:panel-/);
      expect(r.panelName).toMatch(/panel$/);
    }
  });

  it("returns ok:false with no rows when no tabs exist", async () => {
    const { Graph } = await import("../../src/graph/graph.js");
    const empty = new Graph();
    const result = await task1({ graph: empty, target: "synthetic" });
    expect(result.ok).toBe(false);
    expect(result.data).toEqual([]);
  });

  it("tolerates a tab with no aria-controls edge by reporting (no edge)", async () => {
    const graph = buildCannedGraph();
    // Add a 4th tab with no edge.
    graph.upsertAx({
      id: "ax:tab-orphan",
      type: "ax-node",
      pageId: "page:home",
      role: "tab",
      name: "Orphan",
      nameSource: "content",
      states: { expanded: null, disabled: null, pressed: null, selected: false, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: "horizontal", posInSet: 4, setSize: 4, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: "tabs",
      focusable: true, visibility: "visible", inPageDomOrder: 4,
      parentAxId: null,
      provenance: "html:parser",
    });
    const result = await task1({ graph, target: "synthetic" });
    const rows = result.data as Array<{ tabName: string; panelAxId: string }>;
    const orphan = rows.find((r) => r.tabName === "Orphan")!;
    expect(orphan).toBeDefined();
    expect(orphan.panelAxId).toBe("(no edge)");
  });
});
