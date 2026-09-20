/**
 * Unit tests for the graph store — JSON at rest, no OPFS, no SQLite.
 * Uses Node's tmpdir so we don't pollute the repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Graph } from "../../src/graph/graph.js";
import {
  GraphStore,
  loadFromDocument,
  hashFrontier,
  hashPageContent,
} from "../../src/store/store.js";
import type { PageNode, AxNode, Capability, DtcgToken, StateNode } from "../../src/graph/types.js";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "awg-store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function seedGraph(): Graph {
  const g = new Graph();
  const page: PageNode = {
    id: "page:https://example.com/",
    type: "page", url: "https://example.com/", title: "Example",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://example.com/", crawledAt: new Date(0).toISOString(), parentPageId: null,
  };
  const ax: AxNode = {
    id: "ax:root", type: "ax-node", pageId: page.id, role: "region", name: "Example",
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t" as const,
  };
  const cap: Capability = {
    id: "cap:search", type: "capability", name: "search", description: "search",
    inputSchema: {}, outputSchema: {}, source: "fallback",
    binding: { kind: "ax-node", axId: "ax:root", selector: "[data-cap=search]" },
    security: "READ", provenance: "declared:t", pageId: page.id,
  };
  const token: DtcgToken = { $value: "#0064c8", $type: "color", $description: "Action primary" };
  g.upsertPage(page);
  g.upsertAx(ax);
  g.upsertCapability(cap);
  g.upsertToken("color.action.primary.bg", token);
  return g;
}

describe("GraphStore", () => {
  it("writes graph.json, design-tokens.json, and crawl.cmeta.json", async () => {
    const g = seedGraph();
    const store = new GraphStore(dir);
    const doc = await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: "t0", finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
    });
    expect(doc.version).toBe("1.0.0");
    expect(doc.pages).toHaveLength(1);
    expect(doc.axNodes).toHaveLength(1);
    expect(doc.capabilities).toHaveLength(1);

    // Files exist
    const graphRaw = await readFile(join(dir, "graph.json"), "utf8");
    const tokensRaw = await readFile(join(dir, "design-tokens.json"), "utf8");
    const metaRaw = await readFile(join(dir, "crawl.cmeta.json"), "utf8");
    expect(JSON.parse(graphRaw).version).toBe("1.0.0");
    expect(JSON.parse(tokensRaw).color.action["primary"].bg.$value).toBe("#0064c8");
    expect(JSON.parse(metaRaw).rootUrl).toBe("https://example.com/");
  });

  it("appends to crawl.log with newline normalization", async () => {
    const store = new GraphStore(dir);
    await store.appendLog("first");
    await store.appendLog("second\n");
    await store.appendLog("third");
    const log = await readFile(join(dir, "crawl.log"), "utf8");
    expect(log).toBe("first\nsecond\nthird\n");
  });

  it("roundtrips: save then load yields the same nodes", async () => {
    const g = seedGraph();
    const store = new GraphStore(dir);
    await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: "t0", finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
    });
    const reloaded = await store.load();
    expect(reloaded.pageCount).toBe(g.pageCount);
    expect(reloaded.axCount).toBe(g.axCount);
    expect(reloaded.capabilityCount).toBe(g.capabilityCount);
    expect(reloaded.getPage("page:https://example.com/")?.title).toBe("Example");
    expect(reloaded.getAx("ax:root")?.role).toBe("region");
    expect(reloaded.getCapability("cap:search")?.security).toBe("READ");
    expect(reloaded.getToken("color.action.primary.bg")?.$value).toBe("#0064c8");
  });

  it("roundtrips State nodes (PR-8 T10): payload, auth, network, evidence survive", async () => {
    const g = seedGraph();
    const pageId = "page:https://example.com/";
    const stateA: StateNode = {
      id: "state:aaa", type: "state", pageId,
      payload: {
        pageId, route: "https://example.com/",
        auth: { kind: "authenticated", principal: "alice", session: "s1" },
        network: { status: "online", evidence: "page-instrumented" },
        elements: { "ax:root": {
          axId: "ax:root",
          rect: { x: 0, y: 0, w: 100, h: 30 },
          visibility: "visible", zIndex: 0,
          open: null, expanded: null, selected: null, checked: null, pressed: true, busy: null,
          // PR-8g T1: per-element focus flag.
          focused: false,
          ariaStates: { "aria-pressed": "true" },
          visualNodeId: null,
        } },
        // PR-8g T1: State-level focus pointer.
        focusedAxId: null,
        openDialogIds: [], openPopoverIds: [], expandedRegionAxIds: [],
        viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
        conditionalMarkers: {},
      },
      visualFingerprint: "vp:aaa",
      authContext: { kind: "authenticated", principal: "alice", session: "s1" },
      networkContext: { status: "online", evidence: "page-instrumented" },
      provenance: "dom-diff:probe",
      firstObservedAt: "2026-08-30T00:00:00.000Z",
      evidence: [{ kind: "observed", sourceAxId: "ax:root", transitionId: null, at: "2026-08-30T00:00:00.000Z" }],
    };
    g.upsertState(stateA);
    const store = new GraphStore(dir);
    await store.save(g, {
      rootUrl: "https://example.com/", startedAt: "t0", finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
    });
    const reloaded = await store.load();
    expect(reloaded.stateCount).toBe(1);
    const back = reloaded.getState("state:aaa");
    expect(back).toBeDefined();
    expect(back!.pageId).toBe(pageId);
    expect(back!.authContext).toEqual({ kind: "authenticated", principal: "alice", session: "s1" });
    expect(back!.networkContext).toEqual({ status: "online", evidence: "page-instrumented" });
    expect(back!.payload.elements["ax:root"]?.pressed).toBe(true);
    expect(back!.evidence).toHaveLength(1);
    expect(back!.evidence[0]!.kind).toBe("observed");
  });

  it("exists() returns false before save, true after", async () => {
    const store = new GraphStore(dir);
    expect(await store.exists()).toBe(false);
    await store.save(seedGraph(), {
      rootUrl: "https://example.com/", startedAt: "t0", finishedAt: "t1",
      browser: { engine: "firefox", version: "154" },
    });
    expect(await store.exists()).toBe(true);
  });
});

describe("loadFromDocument", () => {
  it("rejects documents with the wrong version", () => {
    expect(() => loadFromDocument({ version: "0.0.1" as any, crawl: { rootUrl: "x", startedAt: "t", finishedAt: "t", browser: { engine: "firefox", version: "1" }, pages: 0, tokens: 0 }, designTokens: {}, pages: [], axNodes: [], visualNodes: [], navElements: [], edges: [], capabilities: [], transitions: [], states: [], authContexts: [] })).toThrow(/version/);
  });

  it("rebuilds the graph from a document", () => {
    const g = new Graph();
    g.upsertPage({
      id: "page:p", type: "page", url: "https://x", title: "X", discoveredVia: [],
      loadStatus: "complete", axTreeRef: { rootAxId: "ax:r", provenance: "aria:t" as const },
      viewport: { w: 1, h: 1, dpr: 1 }, tokensOverride: null, screenshotRef: null,
      canonicalUrl: "https://x", crawledAt: "t", parentPageId: null,
    });
    g.upsertAx({
      id: "ax:r", type: "ax-node", pageId: "page:p", role: "button", name: "go", nameSource: "content",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t" as const,
    });
    const doc = g.toDocument({ rootUrl: "https://x", startedAt: "t", finishedAt: "t", browser: { engine: "firefox", version: "1" }, pages: 1, tokens: 0 });
    const reloaded = loadFromDocument(doc);
    expect(reloaded.getAx("ax:r")?.name).toBe("go");
  });
});

describe("hash helpers", () => {
  it("hashFrontier is order-insensitive (sorts before hashing)", () => {
    const a = hashFrontier(["https://x/a", "https://x/b", "https://x/c"]);
    const b = hashFrontier(["https://x/c", "https://x/a", "https://x/b"]);
    expect(a).toBe(b);
  });

  it("hashPageContent changes when the HTML changes", () => {
    expect(hashPageContent("<html>1</html>")).not.toBe(hashPageContent("<html>2</html>"));
  });
});
