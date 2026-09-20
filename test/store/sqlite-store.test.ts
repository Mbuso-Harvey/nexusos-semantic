/**
 * Unit tests for SqliteGraphStore (Store v2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Graph } from "../../src/graph/graph.js";
import { SqliteGraphStore } from "../../src/store/sqlite-store.js";
import type {
  PageNode,
  AxNode,
  VisualNode,
  StateNode,
  Capability,
  NavElement,
  ComponentGroup,
  DtcgToken,
} from "../../src/graph/types.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "awg-sqlite-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seedFullGraph(): Graph {
  const g = new Graph();
  const page: PageNode = {
    id: "page:home",
    type: "page",
    url: "https://example.com/",
    title: "Example Home",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "html:parser" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: "https://example.com/",
    crawledAt: new Date(0).toISOString(),
    parentPageId: null,
  };
  const axRoot: AxNode = {
    id: "ax:root",
    type: "ax-node",
    pageId: page.id,
    role: "region",
    name: "Main",
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: false,
    visibility: "visible",
    inPageDomOrder: 0,
    parentAxId: null,
    provenance: "html:parser",
  };
  const axButton: AxNode = {
    id: "ax:btn",
    type: "ax-node",
    pageId: page.id,
    role: "button",
    name: "Submit",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    inPageDomOrder: 1,
    parentAxId: "ax:root",
    provenance: "html:parser",
  };
  const vis: VisualNode = {
    id: "vis:btn",
    type: "visual-node",
    axId: "ax:btn",
    pageId: page.id,
    rect: { x: 10, y: 20, w: 100, h: 40 },
    computedStyle: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(0, 100, 200)" },
    designTokenRefs: ["color.accent"],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.evaluate",
    patterns: [{ pattern: "fab", confidence: 0.95, reasons: ["fixed corner button"] }],
    primaryPattern: "fab",
    designTokenBindings: [
      {
        property: "backgroundColor",
        tokenPath: "color.accent",
        tokenValue: "#0064c8",
        actualValue: "rgb(0, 100, 200)",
        matchType: "normalized",
        confidence: 1.0,
      },
    ],
    tokenDrifts: [
      {
        axId: "ax:btn",
        pageId: page.id,
        property: "padding",
        actualValue: "15px",
        suggestedToken: "spacing.md",
        suggestedValue: "16px",
        driftDelta: 1,
        severity: "low",
        message: "Padding deviates 1px from token",
      },
    ],
  };
  const state: StateNode = {
    id: "state:home:initial",
    type: "state",
    pageId: page.id,
    payload: {
      pageId: page.id,
      route: "/",
      auth: { kind: "anonymous" },
      network: { status: "online", evidence: "static" },
      elements: {
        "ax:btn": {
          axId: "ax:btn",
          rect: { x: 10, y: 20, w: 100, h: 40 },
          visibility: "visible",
          zIndex: null,
          open: null,
          expanded: null,
          selected: null,
          checked: null,
          pressed: null,
          busy: null,
          focused: false,
          visualNodeId: "vis:btn",
          ariaStates: {},
        },
      },
      focusedAxId: null,
      openDialogIds: [],
      openPopoverIds: [],
      expandedRegionAxIds: [],
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      conditionalMarkers: {},
    },
    visualFingerprint: "vp:home",
    authContext: { kind: "anonymous" },
    networkContext: { status: "online", evidence: "static" },
    provenance: "dom-diff:probe",
    firstObservedAt: "2026-09-11T12:00:00.000Z",
    evidence: [{ kind: "observed", sourceAxId: "ax:btn", transitionId: null, at: "2026-09-11T12:00:00.000Z" }],
  };
  const cap: Capability = {
    id: "cap:submit",
    type: "capability",
    name: "submit_form",
    description: "Submit the primary form",
    inputSchema: {},
    outputSchema: {},
    source: "webmcp",
    binding: { kind: "ax-node", axId: "ax:btn", selector: "#submit" },
    security: "CONFIRM",
    provenance: "declared:schema",
    pageId: page.id,
  };
  const nav: NavElement = {
    id: "nav:main",
    type: "nav-element",
    pageId: page.id,
    kind: "nav-link-set",
    inPageDomOrder: 1,
    containerAxId: "ax:root",
    memberAxIds: ["ax:btn"],
    activeMemberAxId: null,
    name: "Main navigation",
    provenance: "html:parser",
  };
  const token: DtcgToken = { $value: "#0064c8", $type: "color", $description: "Accent color" };

  g.upsertPage(page);
  g.upsertAx(axRoot);
  g.upsertAx(axButton);
  g.upsertVisual(vis);
  g.upsertState(state);
  g.upsertCapability(cap);
  g.upsertNavElement(nav);
  g.upsertToken("color.accent", token);

  g.upsertEdge({
    id: "edge:ax:root->ax:btn:a11y:child-of",
    type: "edge",
    from: "ax:root",
    to: "ax:btn",
    kind: "a11y:child-of",
    provenance: "html:parser",
  });
  g.upsertEdge({
    id: "edge:page:home->state:home:initial:state:successor",
    type: "edge",
    from: "page:home",
    to: "state:home:initial",
    kind: "state:successor",
    triggers: ["click"],
    provenance: "bidi:script.evaluate",
  });

  return g;
}

describe("SqliteGraphStore", () => {
  it("creates SQLite database file and sidecars", async () => {
    const g = seedFullGraph();
    const store = new SqliteGraphStore(dir);
    const doc = await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: "2026-09-11T12:00:00.000Z",
      finishedAt: "2026-09-11T12:01:00.000Z",
      browser: { engine: "firefox", version: "154" },
    });

    expect(doc.version).toBe("1.0.0");
    expect(existsSync(store.databasePath)).toBe(true);
    expect(existsSync(store.tokensPath)).toBe(true);
    expect(existsSync(store.metaPath)).toBe(true);

    const meta = await store.readMeta();
    expect(meta).not.toBeNull();
    expect(meta?.rootUrl).toBe("https://example.com/");
    expect(meta?.browser.engine).toBe("firefox");
  });

  it("loads the graph back with identical entity counts and integrity", async () => {
    const g = seedFullGraph();
    const store = new SqliteGraphStore(dir);
    await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: "2026-09-11T12:00:00.000Z",
      finishedAt: "2026-09-11T12:01:00.000Z",
      browser: { engine: "firefox", version: "154" },
    });

    const reloaded = await store.load();
    expect(reloaded.pageCount).toBe(g.pageCount);
    expect(reloaded.axCount).toBe(g.axCount);
    expect(reloaded.visualCount).toBe(g.visualCount);
    expect(reloaded.stateCount).toBe(g.stateCount);
    expect(reloaded.capabilityCount).toBe(g.capabilityCount);
    expect(reloaded.navElementCount).toBe(g.navElementCount);
    expect(reloaded.tokenCount).toBe(g.tokenCount);

    const reloadedPage = reloaded.getPage("page:home");
    expect(reloadedPage?.title).toBe("Example Home");

    const reloadedAxBtn = reloaded.getAx("ax:btn");
    expect(reloadedAxBtn?.name).toBe("Submit");
    expect(reloadedAxBtn?.parentAxId).toBe("ax:root");

    const reloadedVis = reloaded.getVisual("vis:btn");
    expect(reloadedVis?.primaryPattern).toBe("fab");
    expect(reloadedVis?.patterns).toHaveLength(1);
    expect(reloadedVis?.patterns?.[0]?.pattern).toBe("fab");
    expect(reloadedVis?.designTokenBindings).toHaveLength(1);
    expect(reloadedVis?.designTokenBindings?.[0]?.tokenPath).toBe("color.accent");
    expect(reloadedVis?.tokenDrifts).toHaveLength(1);
    expect(reloadedVis?.tokenDrifts?.[0]?.suggestedToken).toBe("spacing.md");

    const edges = reloaded.edgesFrom("ax:root");
    expect(edges.some((e) => e.to === "ax:btn" && e.kind === "a11y:child-of")).toBe(true);
  });

  it("supports fast granular queries directly from SQLite", async () => {
    const g = seedFullGraph();
    const store = new SqliteGraphStore(dir);
    await store.save(g, {
      rootUrl: "https://example.com/",
      startedAt: "2026-09-11T12:00:00.000Z",
      finishedAt: "2026-09-11T12:01:00.000Z",
      browser: { engine: "firefox", version: "154" },
    });

    const buttons = store.queryAxNodesByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.name).toBe("Submit");

    const childEdges = store.queryEdgesByKind("a11y:child-of");
    expect(childEdges).toHaveLength(1);
    expect(childEdges[0]?.from).toBe("ax:root");
    expect(childEdges[0]?.to).toBe("ax:btn");
  });
});
