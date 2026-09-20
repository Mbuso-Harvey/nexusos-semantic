/**
 * Test fixture for ED-04 / T5 wire tests — a graph with a real a11y tree
 * (parent -> child edges) so we can test `graph.path` with the new
 * `relation` arg. The fixture's graph:
 *
 *   root
 *   ├── nav
 *   └── main
 *       └── btn
 *
 * Spawned by the test in `mcp-server.test.ts` ("MCP stdio server —
 * graph.path relation (ED-04 / T5)") and stays running until killed.
 */
import { startMcpServer } from "../../src/server/mcp-server.js";
import { Graph } from "../../src/graph/graph.js";

const g = new Graph();
g.upsertPage({
  id: "page:home", type: "page", url: "https://example.com/", title: "T",
  discoveredVia: ["seed"], loadStatus: "complete",
  axTreeRef: { rootAxId: "ax:root", provenance: "aria:tree-walk" },
  viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
  canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
});

const baseStates = { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null };
const baseProperties = { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null };

g.upsertAx({ id: "ax:root", type: "ax-node", pageId: "page:home", role: "region", name: "root", nameSource: "content", states: baseStates, properties: baseProperties, apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:tree-walk" });
g.upsertAx({ id: "ax:nav", type: "ax-node", pageId: "page:home", role: "navigation", name: "nav", nameSource: "content", states: baseStates, properties: baseProperties, apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 1, parentAxId: "ax:root", provenance: "aria:tree-walk" });
g.upsertAx({ id: "ax:main", type: "ax-node", pageId: "page:home", role: "main", name: "main", nameSource: "content", states: baseStates, properties: baseProperties, apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 2, parentAxId: "ax:root", provenance: "aria:tree-walk" });
g.upsertAx({ id: "ax:btn", type: "ax-node", pageId: "page:home", role: "button", name: "btn", nameSource: "content", states: baseStates, properties: baseProperties, apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 3, parentAxId: "ax:main", provenance: "aria:tree-walk" });

const mkEdge = (from: string, to: string) => ({
  id: `edge:${from}->${to}:a11y:child-of`,
  type: "edge" as const, from, to, kind: "a11y:child-of" as const,
  provenance: "aria:tree-walk" as const,
});
g.upsertEdge(mkEdge("ax:root", "ax:nav"));
g.upsertEdge(mkEdge("ax:root", "ax:main"));
g.upsertEdge(mkEdge("ax:main", "ax:btn"));

const { stop } = await startMcpServer(g, { name: "agent-web-graph", version: "0.1.0" });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
