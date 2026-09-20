/**
 * awg-viewer tests — pure summary derivation + the zero-CDN HTTP server.
 *
 * Both halves are exercised with no browser and no BiDi: the summarize
 * model is a pure function over a GraphDocument, and the server serves
 * real JSON over an ephemeral port with real fetch() calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startViewer, type ViewerHandle } from "../../src/viewer/index.js";
import { summarizeGraph } from "../../src/viewer/summarize.js";
import { Graph } from "../../src/graph/graph.js";
import type { GraphDocument } from "../../src/graph/types.js";

function seedGraph(g: Graph): void {
  g.upsertPage({
    id: "page:/", type: "page", url: "https://example.com/", title: "Example",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
    viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
  });
  g.upsertAx({
    id: "ax:root", type: "ax-node", pageId: "page:/", role: "region", name: "Root",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
  });
  g.upsertAx({
    id: "ax:btn", type: "ax-node", pageId: "page:/", role: "button", name: "Sign up",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 1, parentAxId: "ax:root", provenance: "aria:t",
  });
  g.upsertEdge({
    id: "edge:ax:btn->cap:sign:state-feeds-capability",
    type: "edge", from: "ax:btn", to: "cap:sign", kind: "state-feeds-capability",
    provenance: "aria:t",
  });
  g.upsertCapability({
    id: "cap:sign", type: "capability", name: "sign_up", description: "Sign up",
    inputSchema: {}, outputSchema: {}, source: "webmcp",
    binding: { kind: "ax-node", axId: "ax:btn", selector: "[data-cap=sign_up]" },
    security: "EXECUTE", provenance: "declared:t", pageId: "page:/",
  });
  g.upsertToken("color.bg", { $value: "#ffffff", $type: "color" });
  g.upsertState({
    id: "state:s1", type: "state", pageId: "page:/",
    payload: { pageId: "page:/", route: "/", auth: { kind: "anonymous" }, network: { status: "online", evidence: "static" }, elements: {}, focusedAxId: null, openDialogIds: [], openPopoverIds: [], expandedRegionAxIds: [], viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 }, conditionalMarkers: {} },
    visualFingerprint: "fp", authContext: { kind: "anonymous" },
    networkContext: { status: "online", evidence: "static" },
    provenance: "bidi:probe", firstObservedAt: "t",
    evidence: [{ kind: "declared", sourceAxId: "ax:btn", transitionId: null, at: "t" }],
  } as any);
  g.upsertState({
    id: "state:s2", type: "state", pageId: "page:/",
    payload: { pageId: "page:/", route: "/", auth: { kind: "anonymous" }, network: { status: "online", evidence: "static" }, elements: {}, focusedAxId: null, openDialogIds: [], openPopoverIds: [], expandedRegionAxIds: [], viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 }, conditionalMarkers: {} },
    visualFingerprint: "fp2", authContext: { kind: "anonymous" },
    networkContext: { status: "online", evidence: "static" },
    provenance: "bidi:probe", firstObservedAt: "t",
    evidence: [{ kind: "observed", sourceAxId: "ax:btn", transitionId: null, at: "t" }],
  } as any);
  g.upsertEdge({
    id: "edge:state:s1->state:s2:state:successor",
    type: "edge", from: "state:s1", to: "state:s2", kind: "state:successor",
    provenance: "bidi:probe", triggers: ["click"],
  });
  g.upsertEdge({
    id: "edge:ax:root->ax:btn:a11y:child-of",
    type: "edge", from: "ax:root", to: "ax:btn", kind: "a11y:child-of",
    provenance: "aria:t",
  });
}

describe("summarizeGraph", () => {
  function makeDoc(): GraphDocument {
    const g = new Graph();
    seedGraph(g);
    return g.toDocument({
      rootUrl: "https://example.com/",
      startedAt: "t0",
      finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
      pages: g.pageCount,
      tokens: g.tokenCount,
    });
  }

  it("counts every node type and design tokens", () => {
    const m = summarizeGraph(makeDoc());
    expect(m.counts.pages).toBe(1);
    expect(m.counts.axNodes).toBe(2);
    expect(m.counts.edges).toBe(3);
    expect(m.counts.capabilities).toBe(1);
    expect(m.counts.states).toBe(2);
    expect(m.counts.designTokens).toBe(1);
  });

  it("builds the edge-kind histogram", () => {
    const m = summarizeGraph(makeDoc());
    expect(m.edgesByKind["state-feeds-capability"]).toBe(1);
    expect(m.edgesByKind["state:successor"]).toBe(1);
    expect(m.edgesByKind["a11y:child-of"]).toBe(1);
  });

  it("exposes per-page counts", () => {
    const m = summarizeGraph(makeDoc());
    expect(m.pages).toHaveLength(1);
    const page = m.pages[0]!;
    expect(page.axCount).toBe(2);
    expect(page.capabilityCount).toBe(1);
    expect(page.stateCount).toBe(2);
  });

  it("lists state successors available from each state", () => {
    const m = summarizeGraph(makeDoc());
    const s1 = m.states.find((s) => s.id === "state:s1")!;
    expect(s1.successors).toHaveLength(1);
    expect(s1.successors[0]!.to).toBe("state:s2");
    expect(s1.successors[0]!.triggers).toEqual(["click"]);
    const s2 = m.states.find((s) => s.id === "state:s2")!;
    expect(s2.successors).toHaveLength(0);
  });
});

describe("startViewer (zero-CDN HTTP)", () => {
  let dir: string;
  let viewer: ViewerHandle;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "awg-viewer-"));
    const g = new Graph();
    seedGraph(g);
    const { GraphStore } = await import("../../src/store/store.js");
    const store = new GraphStore(dir);
    await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: "t0",
      finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
    });
    await writeFile(join(dir, "demo.trace.json"), JSON.stringify({
      version: "1.0.0",
      target: "synthetic",
      graphDir: dir,
      startedAt: "t0",
      finishedAt: "t1",
      tasks: [{
        id: "1-tabs", timestamp: "t", durationMs: 1, output: { ok: true, data: [] },
        budgetMs: 500, withinBudget: true, pass: true, skipped: false,
      }],
      summary: { passed: 1, failed: 0, skipped: 0, overBudget: 0 },
    }));
    viewer = await startViewer({ graphDir: dir, port: 0 });
  }, 15_000);

  afterAll(async () => {
    await viewer.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the viewer HTML shell", async () => {
    const r = await fetch(`${viewer.url}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("awg-viewer");
    expect(html).toContain("<script>");
    expect(html).toContain("/graph.json");
    expect(html).toContain("/summary.json");
    expect(html).toContain("/trace.json");
  });

  it("serves the raw graph.json", async () => {
    const r = await fetch(`${viewer.url}graph.json`);
    expect(r.status).toBe(200);
    const doc = await r.json() as GraphDocument;
    expect(doc.version).toBe("1.0.0");
    expect(doc.pages).toHaveLength(1);
  });

  it("serves the summarized model", async () => {
    const r = await fetch(`${viewer.url}summary.json`);
    expect(r.status).toBe(200);
    const m = await r.json() as { counts: { pages: number } };
    expect(m.counts.pages).toBe(1);
  });

  it("serves the eval trace when present", async () => {
    const r = await fetch(`${viewer.url}trace.json`);
    expect(r.status).toBe(200);
    const t = await r.json() as { summary: { passed: number } };
    expect(t.summary.passed).toBe(1);
  });

  it("serves crawl.cmeta.json when present", async () => {
    const r = await fetch(`${viewer.url}meta.json`);
    expect(r.status).toBe(200);
    const meta = await r.json() as { rootUrl: string };
    expect(meta.rootUrl).toBe("https://example.com/");
  });

  it("returns plain 404 for unknown paths", async () => {
    const r = await fetch(`${viewer.url}does-not-exist`);
    expect(r.status).toBe(404);
  });

  it("returns 404 JSON for trace.json when the eval sidecar is absent", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "awg-viewer-notrace-"));
    const { GraphStore } = await import("../../src/store/store.js");
    const g = new Graph();
    seedGraph(g);
    const store = new GraphStore(emptyDir);
    await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: "t0",
      finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
    });
    const v2 = await startViewer({ graphDir: emptyDir, port: 0 });
    try {
      const r = await fetch(`${v2.url}trace.json`);
      expect(r.status).toBe(404);
      const body = await r.json() as { error: string };
      expect(body.error).toContain("demo.trace.json");
    } finally {
      await v2.stop();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});