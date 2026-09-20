/**
 * Task 3 tests — capabilities matching the (create|update) name pattern.
 */
import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { buildCannedGraph } from "./fixtures/canned-graph.js";
import { task3 } from "../../src/eval/tasks/task3-capabilities.js";
import type { AxNode, Capability, PageNode } from "../../src/graph/types.js";

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

function cap(id: string, name: string, pageId: string, axId: string, security: Capability["security"]): Capability {
  return {
    id, type: "capability", name, description: "",
    inputSchema: {}, outputSchema: {}, source: "webmcp",
    binding: { kind: "ax-node", axId, selector: "#x" },
    security, provenance: "bidi:script.evaluate", pageId,
  };
}

describe("task3 — list capabilities matching /(create|update)/i", () => {
  it("returns one row per matching capability (canned graph: create_ticket)", async () => {
    const graph = buildCannedGraph();
    const result = await task3({ graph, target: "synthetic" });
    expect(result.ok).toBe(true);
    const rows = result.data as Array<{ name: string; a11y: { role: string; name: string } | null }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toContain("create_ticket");
    expect(names).not.toContain("delete_workspace");
    expect(names).not.toContain("search_docs");
  });

  it("resolves the a11y binding (role + name) for each match", async () => {
    const graph = buildCannedGraph();
    const result = await task3({ graph, target: "synthetic" });
    const rows = result.data as Array<{ name: string; a11y: { role: string; name: string } | null }>;
    const ticket = rows.find((r) => r.name === "create_ticket")!;
    expect(ticket).toBeDefined();
    expect(ticket.a11y).toEqual({ role: "button", name: "New ticket" });
  });

  it("returns ok:false (empty data) when no capability matches", async () => {
    const g = new Graph();
    g.upsertPage(page("page:/", "https://example.com/"));
    g.upsertAx(axBtn("ax:btn", "page:/", "Hello"));
    g.upsertCapability(cap("cap:hello:0", "hello_world", "page:/", "ax:btn", "READ"));
    const result = await task3({ graph: g, target: "synthetic" });
    expect(result.ok).toBe(false);
    expect(result.data).toEqual([]);
  });
});
