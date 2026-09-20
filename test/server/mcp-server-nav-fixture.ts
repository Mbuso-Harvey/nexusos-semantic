/**
 * Test fixture for PR-7 / ED-03 wire tests — a graph with a real
 * navigation hierarchy so we can test `graph.path` with the new
 * `target: "page"` arg.
 *
 * The fixture's nav hierarchy:
 *
 *   page:/
 *   ├── page:/settings
 *   │   └── page:/settings/appearance
 *   └── page:/about
 *
 * Spawned by the test in `mcp-server.test.ts` ("MCP stdio server —
 * graph.path page target (ED-03 / T5)") and stays running until killed.
 */
import { startMcpServer } from "../../src/server/mcp-server.js";
import { Graph } from "../../src/graph/graph.js";

const g = new Graph();

const mkPage = (id: string, url: string, parentPageId: string | null) => ({
  id, type: "page" as const, url, title: url,
  discoveredVia: ["seed"], loadStatus: "complete" as const,
  axTreeRef: { rootAxId: "ax:root", provenance: "html:t" as const },
  viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
  canonicalUrl: url, crawledAt: "t", parentPageId,
});
g.upsertPage(mkPage("page:/", "https://example.com/", null));
g.upsertPage(mkPage("page:/settings", "https://example.com/settings", "page:/"));
g.upsertPage(mkPage("page:/about", "https://example.com/about", "page:/"));
g.upsertPage(mkPage("page:/settings/appearance", "https://example.com/settings/appearance", "page:/settings"));

const mkNavEdge = (from: string, to: string) => ({
  id: `edge:${from}->${to}:nav:child-of`,
  type: "edge" as const, from, to, kind: "nav:child-of" as const,
  provenance: "html:hierarchy" as const,
});
g.upsertEdge(mkNavEdge("page:/", "page:/settings"));
g.upsertEdge(mkNavEdge("page:/", "page:/about"));
g.upsertEdge(mkNavEdge("page:/settings", "page:/settings/appearance"));

const { stop } = await startMcpServer(g, { name: "agent-web-graph", version: "0.1.0" });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
