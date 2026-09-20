/**
 * Test fixture — the script the MCP server tests spawn as a child process.
 * It builds a tiny seed graph, exposes it via the MCP stdio server, and
 * stays running until the parent kills it.
 */
import { startMcpServer } from "../../src/server/mcp-server.js";
import { Graph } from "../../src/graph/graph.js";

const g = new Graph();
g.upsertPage({
  id: "page:/", type: "page", url: "https://example.com/", title: "Example",
  discoveredVia: ["seed"], loadStatus: "complete",
  axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
  viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
  canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
});
g.upsertAx({
  id: "ax:root", type: "ax-node", pageId: "page:/", role: "region", name: "Example",
  nameSource: "aria-label",
  states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
  properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
  apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
});
g.upsertAx({
  id: "ax:btn", type: "ax-node", pageId: "page:/", role: "button", name: "Sign up",
  nameSource: "aria-label",
  states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
  properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
  apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 1, parentAxId: null, provenance: "aria:t",
});
g.upsertAx({
  id: "ax:other", type: "ax-node", pageId: "page:/", role: "link", name: "Other",
  nameSource: "aria-label",
  states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
  properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
  apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 2, parentAxId: null, provenance: "aria:t",
});
g.upsertCapability({
  id: "cap:sign", type: "capability", name: "sign_up", description: "Sign up",
  inputSchema: {}, outputSchema: {}, source: "fallback",
  binding: { kind: "ax-node", axId: "ax:btn", selector: "[data-cap=sign_up]" },
  security: "EXECUTE", provenance: "declared:t", pageId: "page:/",
});
g.upsertVisual({
  id: "vis:page:/:ax:btn",
  type: "visual-node",
  axId: "ax:btn",
  pageId: "page:/",
  rect: { x: 10, y: 20, w: 200, h: 40 },
  computedStyle: { display: "inline-block", position: "relative" },
  designTokenRefs: [],
  tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
  provenance: "aria:t",
  viewport: { name: "desktop", w: 1440, h: 900, dpr: 1 },
  viewportObservations: {
    desktop: {
      viewport: { name: "desktop", w: 1440, h: 900, dpr: 1 },
      rect: { x: 10, y: 20, w: 200, h: 40 },
      computedStyle: { display: "inline-block", position: "relative" },
      visibility: "visible",
      crawledAt: "2026-09-01T00:00:00.000Z",
    },
    mobile: {
      viewport: { name: "mobile", w: 390, h: 844, dpr: 3 },
      rect: { x: 10, y: 20, w: 100, h: 40 },
      computedStyle: { display: "block", position: "relative" },
      visibility: "visible",
      crawledAt: "2026-09-01T00:00:00.000Z",
    },
  },
});

g.upsertToken("color.primary", {
  $value: "#0066cc",
  $type: "color",
  $description: "Primary brand color",
});

const { stop } = await startMcpServer(g, { name: "agent-web-graph", version: "0.1.0" });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
