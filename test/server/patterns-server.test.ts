/**
 * VI-04: Server tests for get_visual_patterns and query_page_layout_mutations.
 * Tests both JSON-RPC TCP server and MCP tool dispatch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphServer, GraphClient } from "../../src/server/server.js";
import { buildMcpServer } from "../../src/server/mcp-server.js";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode, AxNode, VisualNode, ViewportObservation } from "../../src/graph/types.js";
import { DEFAULT_VIEWPORT_PROFILES } from "../../src/graph/types.js";

const PAGE_ID = "page:https://example.com/";

function seed(g: Graph) {
  g.upsertPage({
    id: PAGE_ID,
    type: "page",
    url: "https://example.com/",
    title: "Patterns Test",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
    viewport: { w: 1440, h: 900, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: "https://example.com/",
    crawledAt: "t",
    parentPageId: null,
  });

  g.upsertAx({
    id: "ax:fab",
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "Quick Action",
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    inPageDomOrder: 1,
    parentAxId: null,
    provenance: "aria:t",
  });

  const visFab: VisualNode = {
    id: "vis:fab",
    type: "visual-node",
    axId: "ax:fab",
    pageId: PAGE_ID,
    rect: { x: 1350, y: 820, w: 56, h: 56 },
    computedStyle: { position: "fixed", "z-index": "100", cursor: "pointer" },
    designTokenRefs: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "aria:t",
    patterns: [{ pattern: "fab", confidence: 0.95, reasons: ["fixed", "corner"] }],
    primaryPattern: "fab",
  };
  g.upsertVisual(visFab);

  const obsDesktop: ViewportObservation = {
    viewport: DEFAULT_VIEWPORT_PROFILES.desktop,
    rect: { x: 1350, y: 820, w: 56, h: 56 },
    visibility: "visible",
    computedStyle: { position: "fixed" },
    crawledAt: new Date().toISOString(),
  };
  const obsMobile: ViewportObservation = {
    viewport: DEFAULT_VIEWPORT_PROFILES.mobile,
    rect: { x: 320, y: 770, w: 56, h: 56 },
    visibility: "visible",
    computedStyle: { position: "fixed" },
    crawledAt: new Date().toISOString(),
  };
  g.addViewportObservation("ax:fab", obsDesktop);
  g.addViewportObservation("ax:fab", obsMobile);
}

describe("VI-04: Server endpoints for visual patterns and layout mutations", () => {
  let g: Graph;
  let server: GraphServer;
  let client: GraphClient;
  let port: number;

  beforeEach(async () => {
    g = new Graph();
    seed(g);
    server = new GraphServer(g);
    const addr = await server.start(0);
    port = addr.port;
    client = new GraphClient("127.0.0.1", port);
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it("JSON-RPC: get_visual_patterns returns detected visual patterns", async () => {
    const res: any = await client.call("get_visual_patterns", {
      pageId: PAGE_ID,
      pattern: "fab",
    });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(1);
    expect(res[0].axId).toBe("ax:fab");
    expect(res[0].primaryPattern).toBe("fab");

    // Also test alias graph.visualPatterns
    const resAlias: any = await client.call("graph.visualPatterns", {
      pageId: PAGE_ID,
    });
    expect(Array.isArray(resAlias)).toBe(true);
    expect(resAlias.length).toBe(1);
  });

  it("JSON-RPC: query_page_layout_mutations returns mutation analysis", async () => {
    const res: any = await client.call("query_page_layout_mutations", {
      pageId: PAGE_ID,
      fromViewport: "desktop",
      toViewport: "mobile",
    });
    expect(res).toBeDefined();
    expect(res.pageId).toBe(PAGE_ID);
    expect(res.summary.totalElements).toBe(1);
    expect(res.breakpointDescription).toContain("desktop(1440px) to mobile(390px)");

    // Also test alias graph.pageLayoutMutations
    const resAlias: any = await client.call("graph.pageLayoutMutations", {
      pageId: PAGE_ID,
      fromViewport: "desktop",
      toViewport: "mobile",
    });
    expect(resAlias).toBeDefined();
    expect(resAlias.pageId).toBe(PAGE_ID);
  });

  it("MCP tools: get_visual_patterns and query_page_layout_mutations are registered", async () => {
    const mcpServer = buildMcpServer(g);
    expect(mcpServer).toBeDefined();
  });
});
