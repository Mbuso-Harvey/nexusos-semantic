/**
 * Unit tests for the graph server — line-delimited JSON-RPC 2.0 over local
 * TCP. No mocks for the wire: each test starts the server, connects a real
 * client, sends real bytes, and asserts on the response.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphServer, GraphClient } from "../../src/server/server.js";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode, AxNode, Capability } from "../../src/graph/types.js";

function seed(g: Graph) {
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
  g.upsertCapability({
    id: "cap:sign", type: "capability", name: "sign_up", description: "Sign up",
    inputSchema: {}, outputSchema: {}, source: "fallback",
    binding: { kind: "ax-node", axId: "ax:btn", selector: "[data-cap=sign_up]" },
    security: "EXECUTE", provenance: "declared:t", pageId: "page:/",
  });
  g.upsertVisual({
    id: "vis:btn", type: "visual-node", axId: "ax:btn", pageId: "page:/",
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
  g.upsertVisual({
    id: "vis:grid-main", type: "visual-node", axId: "ax:grid", pageId: "page:/",
    rect: { x: 0, y: 0, w: 1200, h: 800 },
    computedStyle: { display: "grid" },
    designTokenRefs: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "aria:t",
    isVisualContainer: true,
    containerType: "grid",
    viewport: { name: "desktop", w: 1440, h: 900, dpr: 1 },
  });
  g.upsertVisual({
    id: "vis:modal-overlay", type: "visual-node", axId: "ax:modal", pageId: "page:/",
    rect: { x: 0, y: 0, w: 1440, h: 900 },
    computedStyle: { display: "block", position: "fixed" },
    designTokenRefs: [],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "aria:t",
    occlusion: {
      visibleRatio: 0,
      isOccluded: true,
      occludedBy: [],
      clippedRect: null,
      isOffscreen: true,
      occludedArea: 0,
      visibleArea: 0,
    },
  });
  g.upsertEdge({
    id: "edge:vis:grid-main->vis:btn:visual:above",
    type: "edge",
    from: "vis:grid-main",
    to: "vis:btn",
    kind: "visual:above",
    provenance: "aria:t",
    spatial: { distance: 10, overlap: 200 },
  });
}

describe("GraphServer over TCP", () => {
  let g: Graph;
  let srv: GraphServer;
  let cli: GraphClient;
  let port = 0;

  beforeEach(async () => {
    g = new Graph();
    seed(g);
    srv = new GraphServer(g);
    const addr = await srv.start(0); // ephemeral port
    port = addr.port;
    cli = new GraphClient("127.0.0.1", port);
    await cli.connect();
  });

  afterEach(async () => {
    cli.close();
    await srv.stop();
  });

  it("graph.query returns matching ax-nodes", async () => {
    const res: any = await cli.call("graph.query", { select: "ax-node", where: { role: "button" } });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].node.id).toBe("ax:btn");
  });

  it("graph.tool returns capabilities on a page", async () => {
    const res: any = await cli.call("graph.tool", { pageId: "page:/" });
    expect(res.capabilities).toHaveLength(1);
    expect(res.capabilities[0].id).toBe("cap:sign");
  });

  it("graph.act returns a decision for an EXECUTE capability", async () => {
    const res: any = await cli.call("graph.act", { capabilityId: "cap:sign", input: {} });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe("EXECUTE");
    expect(res.binding.selector).toBe("[data-cap=sign_up]");
  });

  it("graph.act refuses a CONFIRM capability without confirm:true", async () => {
    // Promote the capability to CONFIRM by editing it
    g.getCapability("cap:sign")!.security = "CONFIRM";
    const res: any = await cli.call("graph.act", { capabilityId: "cap:sign", input: {} });
    expect(res.ok).toBe(false);
    expect(res.decision.requireConfirm).toBe(true);
  });

  it("graph.explain returns the neighborhood of an ax-node", async () => {
    const res: any = await cli.call("graph.explain", { id: "ax:root", depth: 1 });
    expect(res.root.id).toBe("ax:root");
    expect(res.page.canonicalUrl).toBe("https://example.com/");
    expect(res.capabilities).toHaveLength(1);
  });

  it("graph.explain returns an error for an unknown id", async () => {
    await expect(cli.call("graph.explain", { id: "ax:nope" })).rejects.toThrow(/not found/);
  });

  it("get_visual returns visual snapshot by axId", async () => {
    const res: any = await cli.call("get_visual", { axId: "ax:btn" });
    expect(res.id).toBe("vis:btn");
    expect(res.rect.w).toBe(200);
  });

  it("get_visual returns observation for a specific viewport", async () => {
    const res: any = await cli.call("get_visual", { axId: "ax:btn", viewport: "mobile" });
    expect(res.viewport.name).toBe("mobile");
    expect(res.rect.w).toBe(100);
  });

  it("query_viewport_diff returns geometric and style diff", async () => {
    const res: any = await cli.call("query_viewport_diff", {
      axId: "ax:btn",
      fromViewport: "desktop",
      toViewport: "mobile",
    });
    expect(res.axId).toBe("ax:btn");
    expect(res.rectDelta.dw).toBe(-100);
    expect(res.summary).toContain("resized from 200×40");
  });

  it("graph.viewportDiff alias also returns diff", async () => {
    const res: any = await cli.call("graph.viewportDiff", {
      axId: "ax:btn",
      fromViewport: "desktop",
      toViewport: "mobile",
    });
    expect(res.axId).toBe("ax:btn");
    expect(res.rectDelta.dw).toBe(-100);
  });

  it("get_visual_containers returns layout containers", async () => {
    const res: any = await cli.call("get_visual_containers", {});
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(1);
    expect(res[0].id).toBe("vis:grid-main");
    expect(res[0].containerType).toBe("grid");

    const resAlias: any = await cli.call("graph.visualContainers", { pageId: "page:/" });
    expect(resAlias.length).toBe(1);
    expect(resAlias[0].id).toBe("vis:grid-main");
  });

  it("get_spatial_neighbors returns spatial neighbors", async () => {
    const res: any = await cli.call("get_spatial_neighbors", { visId: "vis:grid-main" });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(1);
    expect(res[0].node.id).toBe("vis:btn");
    expect(res[0].edge.kind).toBe("visual:above");
  });

  it("graph.spatialNeighbors alias filters by direction", async () => {
    const res: any = await cli.call("graph.spatialNeighbors", { visId: "vis:grid-main", direction: "above" });
    expect(res.length).toBe(1);
    expect(res[0].node.id).toBe("vis:btn");

    const resNone: any = await cli.call("graph.spatialNeighbors", { visId: "vis:grid-main", direction: "below" });
    expect(resNone.length).toBe(0);
  });

  it("get_occluded_nodes returns occluded visual nodes", async () => {
    const res: any = await cli.call("get_occluded_nodes", { pageId: "page:/" });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(1);
    expect(res[0].id).toBe("vis:modal-overlay");
  });


  it("query_visual_regression executes diff over JSON-RPC", async () => {
    const res: any = await cli.call("query_visual_regression", { pageId: "page:/" });
    expect(res.pageId).toBe("page:/");
    expect(res.cumulativeLayoutShift).toBeDefined();
    expect(res.counts).toBeDefined();
  });

  it("lint_design_tokens lints tokens over JSON-RPC", async () => {
    const res: any = await cli.call("lint_design_tokens", { pageId: "page:/" });
    expect(Array.isArray(res)).toBe(true);
  });

  it("export_dtcg_tokens exports token bundle over JSON-RPC", async () => {
    const res: any = await cli.call("export_dtcg_tokens", {});
    expect(res.version).toBe("1.0.0");
    expect(res.tokens).toBeDefined();
  });


  it("graph.path returns not-found for disconnected nodes", async () => {
    g.upsertAx({
      id: "ax:other", type: "ax-node", pageId: "page:/", role: "link", name: "Other",
      nameSource: "aria-label",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 2, parentAxId: null, provenance: "aria:t",
    });
    const res: any = await cli.call("graph.path", { from: "ax:root", to: "ax:other" });
    expect(res.found).toBe(false);
  });

  it("returns an error for an unknown method (JSON-RPC -32601)", async () => {
    await expect(cli.call("graph.bogus", {})).rejects.toThrow(/unknown method/);
  });

  it("returns a parse error for garbage input", async () => {
    // Send a non-JSON line and assert the server sends back error code -32700
    const net = await import("node:net");
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const got = await new Promise<string>((resolve) => {
      sock.setEncoding("utf8");
      sock.once("data", (d: string | Buffer) => resolve(typeof d === "string" ? d : d.toString("utf8")));
      sock.write("this is not json\n");
    });
    sock.destroy();
    const res = JSON.parse(got);
    expect(res.error.code).toBe(-32700);
  });
});

describe("GraphServer in-process dispatch (no socket)", () => {
  it("rejects unknown method with a structured error", async () => {
    const g = new Graph();
    seed(g);
    const srv = new GraphServer(g);
    const res = await srv.dispatch({ jsonrpc: "2.0", id: 7, method: "graph.bogus" });
    expect(res.error?.code).toBe(-32601);
    expect(res.id).toBe(7);
  });

  it("routes graph.query to the query layer", async () => {
    const g = new Graph();
    seed(g);
    const srv = new GraphServer(g);
    const res = await srv.dispatch({
      jsonrpc: "2.0", id: "x", method: "graph.query",
      params: { select: "ax-node" },
    });
    expect(res.result.hits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GraphServer dual-form dispatch (ED-10 Â§5 â€” registry/dispatcher alignment)", () => {
  let g: Graph;
  let srv: GraphServer;
  let cli: GraphClient;
  let port = 0;

  beforeEach(async () => {
    g = new Graph();
    seed(g);
    srv = new GraphServer(g);
    const addr = await srv.start(0); // ephemeral port
    port = addr.port;
    cli = new GraphClient("127.0.0.1", port);
    await cli.connect();
  });

  afterEach(async () => {
    cli.close();
    await srv.stop();
  });

  it("graph_query (the registered MCP tool name) dispatches identically to graph.query", async () => {
    // Found by the Evidence Ledger capability battery (2026-09-16): the
    // dispatcher accepted only the dotted form, so a client calling the
    // documented, registered tool name got "unknown method" (-32601).
    const res: any = await cli.call("graph_query", { select: "ax-node", where: { role: "button" } });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].node.id).toBe("ax:btn");
  });

  it("graph_path, graph_tool, graph_act, graph_explain all dispatch under their registered names", async () => {
    const pathRes: any = await cli.call("graph_path", { from: "ax:root", to: "ax:btn" });
    expect(pathRes).toBeDefined();
    const toolRes: any = await cli.call("graph_tool", { pageId: "page:/" });
    expect(toolRes.capabilities).toHaveLength(1);
    const actRes: any = await cli.call("graph_act", { capabilityId: "cap:sign", input: {} });
    expect(actRes.ok).toBe(true);
    const explainRes: any = await cli.call("graph_explain", { id: "ax:root", depth: 1 });
    expect(explainRes.root.id).toBe("ax:root");
  });

  it("graph_invoke dispatches under its registered name (clean no-BiDi result, not unknown-method)", async () => {
    // The server has no BiDi session here; invokeCapability must return a
    // clean no-page result. The point of this test is that the method
    // DISPATCHES at all instead of hitting the unknown-method default.
    const res: any = await cli.call("graph_invoke", { capabilityId: "cap:sign", input: {} });
    expect(res).toBeDefined();
    expect(JSON.stringify(res)).not.toContain("unknown method");
  });
});