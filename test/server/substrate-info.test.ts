/**
 * R2 gate tests — the `substrate_info` MCP tool and the additive substrate
 * block on `graph_diagnostics`: agents must be able to prove WHAT they are
 * acting on (rootUrl, computed graph hash, build version) and MUST see an
 * explicit "unattributed" warning when the server has no substrate.
 */
import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { buildMcpServer } from "../../src/server/mcp-server.js";
import { NEXUS_VERSION } from "../../src/version.js";

type ToolMap = Record<
  string,
  { handler: (args: unknown) => Promise<{ content?: Array<{ type: string; text: string }>; isError?: boolean }> }
>;

function toolsOf(g: Graph): ToolMap {
  const server = buildMcpServer(g);
  return (server as unknown as { _registeredTools: ToolMap })._registeredTools;
}

function boundGraph(): Graph {
  const g = new Graph();
  g.upsertPage({
    id: "page:/", type: "page", url: "https://app.example.com/", title: "App",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
    viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://app.example.com/", crawledAt: "t", parentPageId: null,
  });
  g.setSubstrateProvenance({
    outputDir: "/substrates/app-example-com",
    graphPath: "/substrates/app-example-com/graph.json",
    graphHash: "aa11".repeat(16),
    crawl: {
      rootUrl: "https://app.example.com/",
      startedAt: "2026-09-14T10:00:00.000Z",
      finishedAt: "2026-09-14T10:01:00.000Z",
      browser: { engine: "firefox", version: "154" },
      pages: 1,
      tokens: 0,
    },
    frontierHash: null,
    buildVersion: "0.1.0",
  });
  return g;
}

describe("substrate_info — provable freshness (R2)", () => {
  it("returns the bound substrate identity", async () => {
    const tools = toolsOf(boundGraph());
    expect(tools["substrate_info"]).toBeDefined();
    const res = await tools["substrate_info"]!.handler({});
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content![0]!.text);
    expect(payload.bound).toBe(true);
    expect(payload.rootUrl).toBe("https://app.example.com/");
    expect(payload.graphHash).toBe("aa11".repeat(16));
    expect(payload.crawlFinishedAt).toBe("2026-09-14T10:01:00.000Z");
    expect(payload.browser).toEqual({ engine: "firefox", version: "154" });
    expect(payload.outputDir).toBe("/substrates/app-example-com");
  });

  it("flags an in-memory graph as UNATTRIBUTED instead of pretending", async () => {
    const g = new Graph(); // no provenance set
    const tools = toolsOf(g);
    const res = await tools["substrate_info"]!.handler({});
    const payload = JSON.parse(res.content![0]!.text);
    expect(payload.bound).toBe(false);
    expect(payload.warning).toMatch(/no substrate provenance|unattributed/i);
    expect(payload.buildVersion).toBe(NEXUS_VERSION);
  });

  it("graph_diagnostics carries the substrate block (additive field)", async () => {
    const tools = toolsOf(boundGraph());
    const res = await tools["graph_diagnostics"]!.handler({});
    const payload = JSON.parse(res.content![0]!.text);
    // Pre-existing fields are intact…
    expect(payload.summary).toBeDefined();
    expect(payload.recommendations).toBeDefined();
    // …and the new provenance block is additive.
    expect(payload.substrate.rootUrl).toBe("https://app.example.com/");
    expect(payload.substrate.graphHash).toBe("aa11".repeat(16));
    expect(payload.substrate.buildVersion).toBe("0.1.0");
  });

  it("is classified as a read — allowed at the AUDIT (read-only) posture", async () => {
    const { EnforcementRegistry } = await import("../../src/security/enforcement-registry.js");
    const registry = new EnforcementRegistry();
    expect(registry.operationFor({ tool: "substrate_info" })).toBe("diagnostics");
    const op = registry.find("diagnostics");
    expect(op?.classification).toBe("read");
  });
});
