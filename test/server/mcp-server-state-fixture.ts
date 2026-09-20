/**
 * Test fixture for PR-8 / T7-T8 wire tests — a graph seeded with
 * a small state graph (User Menu CLOSED → OPEN → Profile-focused)
 * plus the cross-layer edges that the new `graph.path` state target
 * and `graph.query` state predicates operate on.
 *
 * Topology:
 *   state:menu-closed  ──[state:successor: click]──▶  state:menu-open
 *   state:menu-open    ──[state:successor: focus]──▶  state:profile
 *
 * State nodes live on page:https://example.com/ — the same page the
 * nav-elements fixture uses, so the `stateOnPage` predicate is
 * straightforward to test.
 *
 * Spawned by the test in `mcp-server.test.ts` ("MCP stdio server —
 * PR-8 state relations") and stays running until killed.
 */
import { startMcpServer } from "../../src/server/mcp-server.js";
import { Graph } from "../../src/graph/graph.js";
import { buildStatePayload, deriveStateId } from "../../src/graph/state-id.js";

const g = new Graph();

const HOME = "https://example.com/";
const PAGE_HOME = `page:${HOME}`;

const mkPage = (id: string, url: string) => ({
  id, type: "page" as const, url, title: url,
  discoveredVia: ["seed"], loadStatus: "complete" as const,
  axTreeRef: { rootAxId: "ax:root", provenance: "html:t" as const },
  viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
  canonicalUrl: url, crawledAt: "t", parentPageId: null as string | null,
});
g.upsertPage(mkPage(PAGE_HOME, HOME));

// 3 states, each with a distinct payload so the ids are unique.
const baseArgs = {
  pageId: PAGE_HOME,
  route: HOME,
  auth: { kind: "anonymous" as const },
  network: { status: "online" as const, evidence: "static" as const },
  elements: {},
  // PR-8g T1: State-level focus pointer (null unless explicitly set).
  focusedAxId: null,
  openDialogIds: [],
  openPopoverIds: [],
  expandedRegionAxIds: [],
  viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
  conditionalMarkers: {},
};

const closedPayload = buildStatePayload({
  ...baseArgs,
  // mark the user-menu button as present but not pressed
  elements: { "ax:user-menu": { axId: "ax:user-menu", rect: { x: 0, y: 0, w: 1, h: 1 }, visibility: "visible", zIndex: 0, open: null, expanded: null, selected: null, checked: null, pressed: false, busy: null, focused: false, ariaStates: {}, visualNodeId: null } },
});
const openPayload = buildStatePayload({
  ...baseArgs,
  // mark the user-menu button as pressed
  elements: { "ax:user-menu": { axId: "ax:user-menu", rect: { x: 0, y: 0, w: 1, h: 1 }, visibility: "visible", zIndex: 0, open: null, expanded: null, selected: null, checked: null, pressed: true, busy: null, focused: false, ariaStates: {}, visualNodeId: null } },
});
const profilePayload = buildStatePayload({
  ...baseArgs,
  // profile menuitem now has focus
  elements: {
    "ax:user-menu": { axId: "ax:user-menu", rect: { x: 0, y: 0, w: 1, h: 1 }, visibility: "visible", zIndex: 0, open: null, expanded: null, selected: null, checked: null, pressed: true, busy: null, focused: false, ariaStates: {}, visualNodeId: null },
    "ax:profile-item": { axId: "ax:profile-item", rect: { x: 0, y: 0, w: 1, h: 1 }, visibility: "visible", zIndex: 0, open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null, focused: true, ariaStates: { "aria-focused": "true" }, visualNodeId: null },
  },
  // PR-8g T1: State-level focus pointer — profile item is focused.
  focusedAxId: "ax:profile-item",
});

const S_CLOSED = deriveStateId(closedPayload);
const S_OPEN = deriveStateId(openPayload);
const S_PROFILE = deriveStateId(profilePayload);

g.upsertState({
  id: S_CLOSED, type: "state", pageId: PAGE_HOME,
  payload: closedPayload, visualFingerprint: "vp:closed",
  authContext: { kind: "anonymous" },
  networkContext: { status: "online", evidence: "static" },
  provenance: "dom-diff:probe",
  firstObservedAt: "t", evidence: [],
});
g.upsertState({
  id: S_OPEN, type: "state", pageId: PAGE_HOME,
  payload: openPayload, visualFingerprint: "vp:open",
  authContext: { kind: "anonymous" },
  networkContext: { status: "online", evidence: "static" },
  provenance: "dom-diff:probe",
  firstObservedAt: "t", evidence: [],
});
g.upsertState({
  id: S_PROFILE, type: "state", pageId: PAGE_HOME,
  payload: profilePayload, visualFingerprint: "vp:profile",
  authContext: { kind: "anonymous" },
  networkContext: { status: "online", evidence: "static" },
  provenance: "dom-diff:probe",
  firstObservedAt: "t", evidence: [],
});

// state:successor edges (the state transition edges)
g.upsertEdge({
  id: `edge:${S_CLOSED}->${S_OPEN}:state:successor`,
  type: "edge", from: S_CLOSED, to: S_OPEN, kind: "state:successor",
  triggers: ["click"], provenance: "dom-diff:probe",
});
g.upsertEdge({
  id: `edge:${S_OPEN}->${S_PROFILE}:state:successor`,
  type: "edge", from: S_OPEN, to: S_PROFILE, kind: "state:successor",
  triggers: ["focus"], provenance: "dom-diff:probe",
});

const { stop } = await startMcpServer(g, { name: "agent-web-graph", version: "0.1.0" });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
