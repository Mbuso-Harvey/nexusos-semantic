import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { buildMcpServer } from "../../src/server/mcp-server.js";

describe("MCP CDP Chrome Substrate Tools (Phase D4)", () => {
  it("registers chrome tools when the chrome option is enabled", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { chrome: true });
    expect(server).toBeDefined();

    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(tools.chrome_targets).toBeDefined();
    expect(tools.chrome_read_tab).toBeDefined();
    expect(tools.chrome_snapshot_tab).toBeDefined();
    expect(tools.chrome_get_cookies).toBeDefined();
    expect(tools.chrome_navigate).toBeDefined();
    expect(tools.chrome_launch).toBeDefined();
  });

  it("does not register chrome tools when the chrome option is absent", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, {});
    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(tools.chrome_targets).toBeUndefined();
    expect(tools.chrome_read_tab).toBeUndefined();
  });

  it("chrome_targets handler returns a structured error when Chrome has no debug port", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { chrome: true });
    const tool = (server as any)._registeredTools.chrome_targets;
    expect(tool).toBeDefined();

    // No Chrome with --remote-debugging-port=9222 is running in CI; the
    // handler must return a structured isError response (not throw).
    const res = await tool.handler({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("chrome_targets failed");
  });
});

describe("MCP Desktop Substrate Tools (Phase D3)", () => {
  it("registers desktop tools when desktop option is enabled", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { desktop: true });
    expect(server).toBeDefined();

    // Verify tools registered
    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(tools.desktop_list_windows).toBeDefined();
    expect(tools.desktop_scrape_window).toBeDefined();
    expect(tools.desktop_kinetic_action).toBeDefined();
  });

  const isWindows = process.platform === "win32";

  it.runIf(isWindows)("executes desktop_list_windows tool handler successfully", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { desktop: true });
    const tool = (server as any)._registeredTools.desktop_list_windows;
    expect(tool).toBeDefined();

    const res = await tool.handler({});
    expect(res.isError).toBeFalsy();
    expect(res.content).toBeDefined();
    expect(res.content[0].type).toBe("text");

    const windows = JSON.parse(res.content[0].text);
    expect(Array.isArray(windows)).toBe(true);
    expect(windows.length).toBeGreaterThan(0);
  });
});

