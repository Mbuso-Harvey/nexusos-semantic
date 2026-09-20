/**
 * MCP server tests — spawn the server as a child process, speak the real
 * stdio JSON-RPC protocol, and verify the 5 tools work end-to-end.
 *
 * The MCP client speaks line-delimited JSON-RPC 2.0 (same as our TCP server,
 * different framing). We initialize the session, then call each tool.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode, AxNode, Capability } from "../../src/graph/types.js";

function makeServerEntry() {
  // The server entry script is in src/server/mcp-server.ts. We spawn it
  // through tsx so the test runs without a build step. The server reads a
  // graph from the GRAPH_SEED env var; in tests we point it at a seed
  // function that uses a Graph pre-populated via the same module the test
  // imports.
  const entry = join(process.cwd(), "test/server/mcp-server-fixture.ts");
  return spawn("node", ["--import", "tsx/esm", entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
}

interface JsonRpcMsg { jsonrpc: "2.0"; id?: number | string; method?: string; result?: any; error?: any; params?: any; }

class McpStdioClient {
  private buf = "";
  private waiters = new Map<number, (msg: JsonRpcMsg) => void>();
  private nextId = 1;
  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
  }
  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMsg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined) {
        const w = this.waiters.get(msg.id as number);
        if (w) { this.waiters.delete(msg.id as number); w(msg); }
      }
    }
  }
  send(method: string, params?: any): Promise<JsonRpcMsg> {
    const id = this.nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(JSON.stringify(req) + "\n");
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }
  close() {
    this.proc.kill();
  }
}

// The fixture script the child process runs — it builds the same seed
// graph and serves it via the MCP server.
describe("MCP stdio server (real wire protocol)", () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: McpStdioClient;

  beforeAll(async () => {
    proc = makeServerEntry();
    client = new McpStdioClient(proc);
    // Drain stderr to avoid noise in test output
    proc.stderr.on("data", () => undefined);
    // The MCP SDK requires an initialize handshake before any tool call.
    const init = await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0" },
    });
    expect(init.result).toBeDefined();
    expect(init.result.serverInfo.name).toBe("agent-web-graph");
  });

  afterAll(() => {
    client.close();
  });

  it("lists the 6 graph tools", async () => {
    const res = await client.send("tools/list", {});
    if (!res.result || !res.result.tools) {
      throw new Error("tools/list returned no tools. full result: " + JSON.stringify(res));
    }
    const names = res.result.tools.map((t: any) => t.name).sort();
    // PR-9 / ED-02: `graph_invoke` is the execute-path tool; the other 5
    // (query, path, tool, act, explain) are unchanged. Pre-PR-9 SDK
    // callers keep working — `graph_invoke` is additive.
    // VI tools: get_visual, query_viewport_diff, get_visual_containers,
    // get_spatial_neighbors, get_occluded_nodes, get_visual_patterns, query_page_layout_mutations,
    // export_dtcg_tokens, lint_design_tokens, query_visual_regression.
    expect(names).toEqual([
      "export_dtcg_tokens",
      "get_occluded_nodes",
      "get_spatial_neighbors",
      "get_visual",
      "get_visual_containers",
      "get_visual_patterns",
      "graph_act",
      "graph_diagnostics",
      "graph_explain",
      "graph_invoke",
      "graph_path",
      "graph_query",
      "graph_tool",
      "lint_design_tokens",
      "query_page_layout_mutations",
      "query_viewport_diff",
      "query_visual_regression",
      "substrate_info",
    ]);
  });

  it("get_visual returns visual node and viewport observation", async () => {
    const res = await client.send("tools/call", {
      name: "get_visual",
      arguments: { axId: "ax:btn" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.id).toBe("vis:page:/:ax:btn");
    expect(payload.rect.w).toBe(200);

    const resMobile = await client.send("tools/call", {
      name: "get_visual",
      arguments: { axId: "ax:btn", viewport: "mobile" },
    });
    const payloadMobile = JSON.parse(resMobile.result.content[0].text);
    expect(payloadMobile.viewport.name).toBe("mobile");
    expect(payloadMobile.rect.w).toBe(100);
  });

  it("query_viewport_diff returns responsive delta between viewports", async () => {
    const res = await client.send("tools/call", {
      name: "query_viewport_diff",
      arguments: { axId: "ax:btn", fromViewport: "desktop", toViewport: "mobile" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.axId).toBe("ax:btn");
    expect(payload.rectDelta.dw).toBe(-100);
    expect(payload.rectDelta.widthPercentChange).toBe(-50);
    expect(payload.summary).toContain("resized from 200×40");
  });

  it("export_dtcg_tokens returns valid DTCG token bundle", async () => {
    const res = await client.send("tools/call", {
      name: "export_dtcg_tokens",
      arguments: {},
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.version).toBe("1.0.0");
    expect(payload.tokens.color.primary).toBeDefined();
    expect(payload.tokens.color.primary.$value).toBe("#0066cc");
  });

  it("lint_design_tokens lints token drifts on page", async () => {
    const res = await client.send("tools/call", {
      name: "lint_design_tokens",
      arguments: { pageId: "page:/" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(Array.isArray(payload)).toBe(true);
  });

  it("query_visual_regression executes visual regression diff", async () => {
    const res = await client.send("tools/call", {
      name: "query_visual_regression",
      arguments: {
        pageId: "page:/",
      },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.pageId).toBe("page:/");
    expect(payload.maxSeverity).toBeDefined();
    expect(typeof payload.cumulativeLayoutShift).toBe("number");
  });


  it("graph_query returns matching ax-nodes", async () => {
    const res = await client.send("tools/call", {
      name: "graph_query",
      arguments: { select: "ax-node", where: { role: "button" } },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].node.id).toBe("ax:btn");
  });

  it("graph_tool returns capabilities on a page", async () => {
    const res = await client.send("tools/call", {
      name: "graph_tool",
      arguments: { pageId: "page:/" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.capabilities).toHaveLength(1);
    expect(payload.capabilities[0].id).toBe("cap:sign");
  });

  it("graph_act returns a decision for an EXECUTE capability", async () => {
    const res = await client.send("tools/call", {
      name: "graph_act",
      arguments: { capabilityId: "cap:sign", input: {} },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.tier).toBe("EXECUTE");
  });

  it("graph_invoke returns isError when the server has no BiDi session attached", async () => {
    // The stdio server is started via `startMcpServer(graph)` with no
    // `bidi` option (this is the offline / no-geckodriver path). The
    // PR-9 / ED-02 contract: `graph_invoke` returns a clean isError
    // response with a "no BiDi session attached" message rather than
    // hanging. Pre-PR-9 SDK callers that use `graph_act` work
    // unchanged (the act path is decision-only).
    const res = await client.send("tools/call", {
      name: "graph_invoke",
      arguments: { capabilityId: "cap:sign", input: {} },
    });
    expect(res.result.isError).toBe(true);
    const text = res.result.content[0].text;
    expect(text).toMatch(/no BiDi session attached/);
  });

  it("graph_explain returns the neighborhood of an ax-node", async () => {
    const res = await client.send("tools/call", {
      name: "graph_explain",
      arguments: { id: "ax:root", depth: 1 },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.root.id).toBe("ax:root");
    expect(payload.page.canonicalUrl).toBe("https://example.com/");
  });

  it("graph_path returns not-found for disconnected nodes", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:root", to: "ax:other" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.found).toBe(false);
  });

  it("returns an isError for an unknown axId in graph_explain", async () => {
    const res = await client.send("tools/call", {
      name: "graph_explain",
      arguments: { id: "ax:nope" },
    });
    expect(res.result.isError).toBe(true);
  });
});

/**
 * ED-04 / T5 wire tests — `graph.path` with the new `relation` arg.
 * These need a graph with a real a11y tree, so they live in their own
 * describe block with their own fixture server.
 */
describe("MCP stdio server — graph.path relation (ED-04 / T5)", () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: McpStdioClient;

  function makeTreeServerEntry() {
    const entry = join(process.cwd(), "test/server/mcp-server-tree-fixture.ts");
    return spawn("node", ["--import", "tsx/esm", entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  beforeAll(async () => {
    proc = makeTreeServerEntry();
    client = new McpStdioClient(proc);
    proc.stderr.on("data", () => undefined);
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "test-client", version: "0" },
    });
  });

  afterAll(() => { client.close(); });

  it("relation:children returns immediate children of an ax node", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:root", relation: "children" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("children");
    expect(payload.nodes.map((n: any) => n.id).sort()).toEqual(["ax:main", "ax:nav"].sort());
  });

  it("relation:descendants returns all descendants bounded by depth", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:root", relation: "descendants", depth: 10 },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("descendants");
    expect(payload.nodes.map((n: any) => n.id).sort()).toEqual(
      ["ax:btn", "ax:main", "ax:nav"].sort(),
    );
  });

  it("relation:parent returns the single parent", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:btn", relation: "parent" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("parent");
    expect(payload.parent?.id).toBe("ax:main");
  });

  it("relation:ancestors returns the chain of parents", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:btn", relation: "ancestors", depth: 5 },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("ancestors");
    expect(payload.nodes.map((n: any) => n.id)).toEqual(["ax:main", "ax:root"]);
  });

  it("without relation, still does shortest-path to `to` (backward compat)", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:root", to: "ax:btn" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.found).toBe(true);
    // root -> main (1 hop) -> btn (2 hops)
    expect(payload.cost).toBe(2);
  });
});

/**
 * PR-7 / ED-03 wire tests — `graph.path` with the new `target: "page"`
 * arg, plus inferred-target dispatch (id prefix "page:" routes to the
 * page-level traversal). The fixture is a small nav hierarchy:
 *   page:/  → {page:/settings, page:/about}
 *   page:/settings → page:/settings/appearance
 */
describe("MCP stdio server — graph.path page target (ED-03 / T5)", () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: McpStdioClient;

  function makeNavServerEntry() {
    const entry = join(process.cwd(), "test/server/mcp-server-nav-fixture.ts");
    return spawn("node", ["--import", "tsx/esm", entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  beforeAll(async () => {
    proc = makeNavServerEntry();
    client = new McpStdioClient(proc);
    proc.stderr.on("data", () => undefined);
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "test-client", version: "0" },
    });
  });

  afterAll(() => { client.close(); });

  it("target:page + relation:children returns immediate child pages", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "page:/", target: "page", relation: "children" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("children");
    expect(payload.target).toBe("page");
    expect(payload.nodes.map((n: any) => n.id).sort()).toEqual(
      ["page:/about", "page:/settings"].sort(),
    );
  });

  it("target:page + relation:ancestors walks the page hierarchy upward", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: {
        from: "page:/settings/appearance",
        target: "page",
        relation: "ancestors",
        depth: 5,
      },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("ancestors");
    expect(payload.target).toBe("page");
    expect(payload.nodes.map((n: any) => n.id)).toEqual([
      "page:/settings", "page:/",
    ]);
  });

  it("target:page + relation:parent returns the single parent page", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "page:/settings/appearance", target: "page", relation: "parent" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("parent");
    expect(payload.target).toBe("page");
    expect(payload.parent?.id).toBe("page:/settings");
  });

  it("dispatch infers target from id prefix: 'page:' id routes to page-level", async () => {
    // No explicit `target` arg; the server should still route to the
    // page-level traversal because the `from` id starts with "page:".
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "page:/", relation: "children" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.target).toBe("page");
    expect(payload.nodes.map((n: any) => n.id).sort()).toEqual(
      ["page:/about", "page:/settings"].sort(),
    );
  });

  it("backward compat: omitting target still works for ax-node ids", async () => {
    // Spawns a separate server (the tree fixture) — children should be the
    // a11y tree children, not page children.
    const treeEntry = join(process.cwd(), "test/server/mcp-server-tree-fixture.ts");
    const treeProc = spawn("node", ["--import", "tsx/esm", treeEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    treeProc.stderr.on("data", () => undefined);
    const treeClient = new McpStdioClient(treeProc);
    await treeClient.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "test-client", version: "0" },
    });
    try {
      const res = await treeClient.send("tools/call", {
        name: "graph_path",
        arguments: { from: "ax:root", relation: "children" },
      });
      const payload = JSON.parse(res.result.content[0].text);
      expect(payload.target).toBe("ax-node");
      expect(payload.nodes.map((n: any) => n.id).sort()).toEqual(
        ["ax:main", "ax:nav"].sort(),
      );
    } finally {
      treeClient.close();
    }
  });
});

/**
 * PR-8a / T6-T7 wire tests — the four new page-level Layer 1
 * relations on `graph.path` (`nav-links`, `breadcrumbs`, `menu`,
 * `tab-of`) and the new `select: "nav-element"` value on
 * `graph.query`. The fixture is seeded with breadcrumb, menu, and
 * tablist NavElements + their cross-layer edges + a nav-link edge.
 */
describe("MCP stdio server — PR-8a nav-level relations", () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: McpStdioClient;

  function makeNavElementsServerEntry() {
    const entry = join(process.cwd(), "test/server/mcp-server-nav-elements-fixture.ts");
    return spawn("node", ["--import", "tsx/esm", entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  beforeAll(async () => {
    proc = makeNavElementsServerEntry();
    client = new McpStdioClient(proc);
    proc.stderr.on("data", () => undefined);
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "test-client", version: "0" },
    });
  });

  afterAll(() => { client.close(); });

  it("relation:nav-links returns pages reachable from a source page", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "page:https://example.com/", relation: "nav-links" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("nav-links");
    expect(payload.target).toBe("page");
    expect(payload.nodes.map((n: any) => n.id)).toEqual(["page:https://example.com/projects"]);
  });

  it("relation:breadcrumbs returns the breadcrumb NavElement + its members", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:page:https://example.com/projects:bc-nav", relation: "breadcrumbs" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("breadcrumbs");
    expect(payload.target).toBe("page");
    // First node is the NavElement; rest are the ordered members.
    const ids = (payload.nodes as any[]).map((n) => n.id);
    expect(ids[0]).toBe("nav:page:https://example.com/projects:breadcrumb:1");
    expect(ids.slice(1).sort()).toEqual(
      [
        "ax:page:https://example.com/projects:bc-home",
        "ax:page:https://example.com/projects:bc-projects",
      ].sort(),
    );
  });

  it("relation:menu returns the menu NavElement + its members", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:page:https://example.com/:user-menu", relation: "menu" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("menu");
    expect(payload.target).toBe("page");
    const ids = (payload.nodes as any[]).map((n) => n.id);
    expect(ids[0]).toBe("nav:page:https://example.com/:menu:1");
    expect(ids.slice(1).sort()).toEqual(
      [
        "ax:page:https://example.com/:user-menu-item-1",
        "ax:page:https://example.com/:user-menu-item-2",
      ].sort(),
    );
  });

  it("relation:tab-of returns the tablist NavElement that contains a tab", async () => {
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: "ax:page:https://example.com/:tab-recent", relation: "tab-of" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("tab-of");
    expect(payload.target).toBe("page");
    const ids = (payload.nodes as any[]).map((n) => n.id);
    expect(ids).toContain("nav:page:https://example.com/:tablist:1");
    expect(ids).toContain("ax:page:https://example.com/:tab-recent");
  });

  it("graph_query with select:nav-element returns NavElements filtered by navKind", async () => {
    const res = await client.send("tools/call", {
      name: "graph_query",
      arguments: { select: "nav-element", where: { navKind: "tablist" } },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].node.id).toBe("nav:page:https://example.com/:tablist:1");
    expect(payload.hits[0].node.activeMemberAxId).toBe("ax:page:https://example.com/:tab-recent");
  });

  it("graph_query with select:nav-element and navInPage filters by page", async () => {
    const res = await client.send("tools/call", {
      name: "graph_query",
      arguments: { select: "nav-element", where: { navInPage: "page:https://example.com/projects" } },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].node.kind).toBe("breadcrumb");
  });
});

/**
 * PR-8 wire tests — state target on graph.path, state select on
 * graph.query. Uses a separate fixture (mcp-server-state-fixture.ts)
 * that seeds a small state graph with 3 nodes and 2 state:successor
 * edges.
 */
describe("MCP stdio server — PR-8 state relations", () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: McpStdioClient;

  function makeStateServerEntry() {
    const entry = join(process.cwd(), "test/server/mcp-server-state-fixture.ts");
    return spawn("node", ["--import", "tsx/esm", entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  beforeAll(async () => {
    proc = makeStateServerEntry();
    client = new McpStdioClient(proc);
    proc.stderr.on("data", () => undefined);
    await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {}, clientInfo: { name: "test-client", version: "0" },
    });
  });

  afterAll(() => { client.close(); });

  it("graph_path with target:state and relation:successors returns 1-hop outgoing states", async () => {
    // We need a real state id. First, ask graph_query for any state,
    // then call graph_path with that id.
    const q = await client.send("tools/call", { name: "graph_query", arguments: { select: "state" } });
    const qp = JSON.parse(q.result.content[0].text);
    const fromId = qp.hits[0].node.id;
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: fromId, target: "state", relation: "successors" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("successors");
    expect(payload.target).toBe("state");
    // Some states have outgoing successors, some don't; the shape
    // must always be { nodes: [...], target: "state" }.
    expect(payload.nodes).toBeDefined();
  });

  it("graph_path with target:state and relation:predecessors returns 1-hop incoming states", async () => {
    const q = await client.send("tools/call", { name: "graph_query", arguments: { select: "state" } });
    const qp = JSON.parse(q.result.content[0].text);
    const fromId = qp.hits[1].node.id;
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: fromId, target: "state", relation: "predecessors" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("predecessors");
    expect(payload.target).toBe("state");
    expect(payload.nodes).toBeDefined();
  });

  it("graph_path with target:state and relation:reachable returns bounded BFS", async () => {
    const q = await client.send("tools/call", { name: "graph_query", arguments: { select: "state" } });
    const qp = JSON.parse(q.result.content[0].text);
    // The first state in the fixture has at least one successor.
    const fromId = qp.hits[0].node.id;
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: fromId, target: "state", relation: "reachable", depth: 5 },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.relation).toBe("reachable");
    expect(payload.target).toBe("state");
    expect(payload.nodes).toBeDefined();
  });

  it("graph_path with target:state and a tree-style relation is rejected", async () => {
    const q = await client.send("tools/call", { name: "graph_query", arguments: { select: "state" } });
    const qp = JSON.parse(q.result.content[0].text);
    const fromId = qp.hits[0].node.id;
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: fromId, target: "state", relation: "children" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.target).toBe("state");
    // The state dispatch returns an empty result for disallowed
    // relations (no error throw; just an empty nodes array).
    expect(payload.nodes).toEqual([]);
  });

  it("graph_path infers state target from a state: prefixed id", async () => {
    const q = await client.send("tools/call", { name: "graph_query", arguments: { select: "state" } });
    const qp = JSON.parse(q.result.content[0].text);
    const fromId = qp.hits[0].node.id;
    // No explicit `target` — the dispatch infers "state" from the prefix.
    const res = await client.send("tools/call", {
      name: "graph_path",
      arguments: { from: fromId, relation: "successors" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.target).toBe("state");
  });

  it("graph_query with select:state returns all state nodes", async () => {
    const res = await client.send("tools/call", { name: "graph_query", arguments: { select: "state" } });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.hits).toHaveLength(3);
    for (const h of payload.hits) {
      expect(h.select).toBe("state");
      expect(h.node.type).toBe("state");
    }
  });

  it("graph_query with select:state and where:stateOnPage filters by page", async () => {
    const res = await client.send("tools/call", {
      name: "graph_query",
      arguments: { select: "state", where: { stateOnPage: "page:https://example.com/" } },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.hits).toHaveLength(3);
  });

  it("graph_query with select:state and where:stateAuthKind filters by auth kind", async () => {
    const res = await client.send("tools/call", {
      name: "graph_query",
      arguments: { select: "state", where: { stateAuthKind: "anonymous" } },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.hits.length).toBeGreaterThanOrEqual(1);
    for (const h of payload.hits) {
      expect(h.node.authContext.kind).toBe("anonymous");
    }
  });
});

// Unit tests for the server builder (don't spawn a process)
describe("buildMcpServer — in-process", () => {
  it("registers 6 tools with valid input schemas", async () => {
    const { buildMcpServer } = await import("../../src/server/mcp-server.js");
    const g = new Graph();
    seed(g);
    const server = buildMcpServer(g);
    // The MCP SDK exposes registered tools via server._registeredTools
    const tools = (server as any)._registeredTools;
    const names = Object.keys(tools).sort();
    // PR-9 / ED-02: `graph_invoke` joins the 5 pre-existing tools.
    // Diagnostics joins as the extraction health & feedback tool.
    // VI tools: get_visual, query_viewport_diff, get_visual_containers,
    // get_spatial_neighbors, get_occluded_nodes, get_visual_patterns, query_page_layout_mutations,
    // export_dtcg_tokens, lint_design_tokens, query_visual_regression.
    expect(names).toEqual([
      "export_dtcg_tokens",
      "get_occluded_nodes",
      "get_spatial_neighbors",
      "get_visual",
      "get_visual_containers",
      "get_visual_patterns",
      "graph_act",
      "graph_diagnostics",
      "graph_explain",
      "graph_invoke",
      "graph_path",
      "graph_query",
      "graph_tool",
      "lint_design_tokens",
      "query_page_layout_mutations",
      "query_viewport_diff",
      "query_visual_regression",
      "substrate_info",
    ]);
    for (const name of names) {
      const t = tools[name];
      expect(t.inputSchema).toBeDefined();
    }
  });
});

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
}
