import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { buildMcpServer } from "../../src/server/mcp-server.js";
import { loadFromDocument } from "../../src/store/store.js";
import type { PageNode, AxNode } from "../../src/graph/types.js";

describe("MCP Diagnostics & Extraction Telemetry Feedback Loop", () => {
  it("registers `graph_diagnostics` tool on MCP server", () => {
    const graph = new Graph();
    const server = buildMcpServer(graph);
    const tools = (server as any)._registeredTools;
    expect(tools.graph_diagnostics).toBeDefined();
  });

  it("reports 100% health score on pristine graph", async () => {
    const graph = new Graph();
    const page: PageNode = {
      id: "page:https://example.com",
      type: "page",
      url: "https://example.com",
      title: "Home",
      discoveredVia: [],
      loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:page:https://example.com:root", provenance: "bidi:script.evaluate" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null,
      screenshotRef: null,
      canonicalUrl: "https://example.com",
      crawledAt: new Date().toISOString(),
      parentPageId: null,
    };
    graph.upsertPage(page);

    const server = buildMcpServer(graph);
    const tool = (server as any)._registeredTools.graph_diagnostics;
    const res = await tool.handler({ includeUnlabeledInteractive: true });
    expect(res.isError).toBeFalsy();

    const data = JSON.parse(res.content[0].text);
    expect(data.summary.healthScorePercent).toBe(100);
    expect(data.summary.pagesLoaded).toBe(1);
    expect(data.summary.pagesFailed).toBe(0);
    expect(data.recommendations[0]).toContain("100% healthy");
  });

  it("accurately detects failed pages, extractor exceptions, and unlabeled buttons", async () => {
    const graph = new Graph();

    const goodPage: PageNode = {
      id: "page:https://example.com/good",
      type: "page",
      url: "https://example.com/good",
      title: "Good Page",
      discoveredVia: [],
      loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:page:https://example.com/good:root", provenance: "bidi:script.evaluate" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null,
      screenshotRef: null,
      canonicalUrl: "https://example.com/good",
      crawledAt: new Date().toISOString(),
      parentPageId: null,
    };
    graph.upsertPage(goodPage);

    const badPage: PageNode = {
      id: "page:https://example.com/timeout",
      type: "page",
      url: "https://example.com/timeout",
      title: "Load Failed",
      discoveredVia: ["page:https://example.com/good"],
      loadStatus: "timeout",
      axTreeRef: { rootAxId: "ax:page:https://example.com/timeout:failed", provenance: "bidi:script.evaluate" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null,
      screenshotRef: null,
      canonicalUrl: "https://example.com/timeout",
      crawledAt: new Date().toISOString(),
      parentPageId: null,
    };
    graph.upsertPage(badPage);
    graph.recordPageError("https://example.com/timeout", "Navigation timed out after 30000ms", "timeout");

    graph.recordExtractorFailure("page:https://example.com/good", "visual", "WebGL context lost during screenshot");

    graph.recordExtractionWarning("page:https://example.com/good", {
      tag: "custom-widget",
      elementId: "cw-1",
      error: "Blocked by ShadowRoot closed mode",
    });

    const unlabeledBtn: AxNode = {
      id: "ax:page:https://example.com/good:btn-mystery",
      type: "ax-node",
      pageId: goodPage.id,
      role: "button",
      name: "",
      nameSource: "content",
      states: { expanded: null, disabled: false, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null,
      focusable: true,
      visibility: "visible",
      inPageDomOrder: 1,
      parentAxId: null,
      provenance: "bidi:script.evaluate",
    };
    graph.upsertAx(unlabeledBtn);

    const server = buildMcpServer(graph);
    const tool = (server as any)._registeredTools.graph_diagnostics;
    const res = await tool.handler({ includeUnlabeledInteractive: true });
    const data = JSON.parse(res.content[0].text);

    expect(data.summary.pagesTotal).toBe(2);
    expect(data.summary.pagesLoaded).toBe(1);
    expect(data.summary.pagesFailed).toBe(1);
    expect(data.summary.healthScorePercent).toBe(50);

    expect(data.failedPages).toHaveLength(1);
    expect(data.failedPages[0].url).toBe("https://example.com/timeout");
    expect(data.failedPages[0].status).toBe("timeout");
    expect(data.failedPages[0].error).toContain("timed out");

    expect(data.extractorFailures).toHaveLength(1);
    expect(data.extractorFailures[0].extractor).toBe("visual");

    expect(data.extractionWarnings).toHaveLength(1);
    expect(data.extractionWarnings[0].tag).toBe("custom-widget");

    expect(data.unlabeledInteractive).toHaveLength(1);
    expect(data.unlabeledInteractive[0].id).toBe(unlabeledBtn.id);

    expect(data.recommendations.some((r: string) => r.includes("page(s) failed to load"))).toBe(true);
    expect(data.recommendations.some((r: string) => r.includes("interactive elements lack accessible names"))).toBe(true);
  });

  it("persists and rehydrates diagnostics in GraphDocument", () => {
    const g1 = new Graph();
    g1.recordExtractorFailure("page:1", "structure", "DOM exception");
    g1.recordPageError("https://error.com", "404 Not Found", "spa-error");
    g1.recordExtractionWarning("page:1", { tag: "div", elementId: "d1", error: "fail" });

    const doc = g1.toDocument({
      rootUrl: "https://test.com",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      browser: { engine: "firefox", version: "135" },
      pages: 0,
      tokens: 0,
    });

    expect(doc.diagnostics).toBeDefined();
    expect(doc.diagnostics?.extractorFailures).toHaveLength(1);
    expect(doc.diagnostics?.pageErrors).toHaveLength(1);
    expect(doc.diagnostics?.extractionWarnings).toHaveLength(1);

    const g2 = loadFromDocument(doc);
    const diag = g2.getDiagnostics();
    expect(diag.extractorFailures).toHaveLength(1);
    expect(diag.extractorFailures[0]?.extractor).toBe("structure");
    expect(diag.pageErrors).toHaveLength(1);
    expect(diag.pageErrors[0]?.url).toBe("https://error.com");
    expect(diag.extractionWarnings).toHaveLength(1);
  });
});
