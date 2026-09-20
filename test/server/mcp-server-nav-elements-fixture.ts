/**
 * Test fixture for PR-8a / T6-T7 wire tests — a graph seeded with
 * NavElements (breadcrumb, menu, tablist, nav-link-set) and the
 * cross-layer edges that drive the four new `graph.path` relations
 * (nav-links / breadcrumbs / menu / tab-of).
 *
 * Topology (pageIds use real canonical URLs because the relate
 * helpers walk the pageId out of axIds via `pageIdOfAxId`):
 *   - page:https://example.com/  ("page:home")
 *   - page:https://example.com/projects
 *
 * Spawned by the test in `mcp-server.test.ts` ("MCP stdio server —
 * PR-8a nav-level relations") and stays running until killed.
 */
import { startMcpServer } from "../../src/server/mcp-server.js";
import { Graph } from "../../src/graph/graph.js";
import type { AxNode } from "../../src/graph/types.js";

const g = new Graph();

const HOME = "https://example.com/";
const PROJ = "https://example.com/projects";
const PAGE_HOME = `page:${HOME}`;
const PAGE_PROJ = `page:${PROJ}`;

const mkPage = (id: string, url: string) => ({
  id, type: "page" as const, url, title: url,
  discoveredVia: ["seed"], loadStatus: "complete" as const,
  axTreeRef: { rootAxId: "ax:root", provenance: "html:t" as const },
  viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
  canonicalUrl: url, crawledAt: "t", parentPageId: null as string | null,
});
g.upsertPage(mkPage(PAGE_HOME, HOME));
g.upsertPage(mkPage(PAGE_PROJ, PROJ));

// -- ax nodes --
// page:home has the user-menu (container) + a tablist (container) with 2 tabs.
const mkAx = (id: string, pageId: string, role: string, name: string, parentAxId: string | null, inPageDomOrder: number): AxNode => ({
  id, type: "ax-node" as const, pageId, role, name,
  nameSource: "aria-label" as const,
  states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
  properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
  apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder, parentAxId, provenance: "html:t" as const,
});

const AX_USER_MENU = `ax:${PAGE_HOME}:user-menu`;
const AX_USER_MENU_I1 = `ax:${PAGE_HOME}:user-menu-item-1`;
const AX_USER_MENU_I2 = `ax:${PAGE_HOME}:user-menu-item-2`;
const AX_TABLIST = `ax:${PAGE_HOME}:tablist`;
const AX_TAB_RECENT = `ax:${PAGE_HOME}:tab-recent`;
const AX_TAB_ARCHIVED = `ax:${PAGE_HOME}:tab-archived`;
const AX_BC_NAV = `ax:${PAGE_PROJ}:bc-nav`;
const AX_BC_HOME = `ax:${PAGE_PROJ}:bc-home`;
const AX_BC_PROJ = `ax:${PAGE_PROJ}:bc-projects`;

g.upsertAx(mkAx(AX_USER_MENU, PAGE_HOME, "menu", "User menu", null, 0));
g.upsertAx(mkAx(AX_USER_MENU_I1, PAGE_HOME, "menuitem", "Profile", AX_USER_MENU, 1));
g.upsertAx(mkAx(AX_USER_MENU_I2, PAGE_HOME, "menuitem", "Sign out", AX_USER_MENU, 2));
g.upsertAx(mkAx(AX_TABLIST, PAGE_HOME, "tablist", "Tabs", null, 3));
g.upsertAx(mkAx(AX_TAB_RECENT, PAGE_HOME, "tab", "Recent", AX_TABLIST, 4));
g.upsertAx(mkAx(AX_TAB_ARCHIVED, PAGE_HOME, "tab", "Archived", AX_TABLIST, 5));

// page:projects has the breadcrumb container.
g.upsertAx(mkAx(AX_BC_NAV, PAGE_PROJ, "navigation", "Breadcrumb", null, 0));
g.upsertAx(mkAx(AX_BC_HOME, PAGE_PROJ, "link", "Home", AX_BC_NAV, 1));
g.upsertAx(mkAx(AX_BC_PROJ, PAGE_PROJ, "link", "Projects", AX_BC_NAV, 2));

// -- NavElements --
const NAV_BC = `nav:${PAGE_PROJ}:breadcrumb:1`;
const NAV_MENU = `nav:${PAGE_HOME}:menu:1`;
const NAV_TABLIST = `nav:${PAGE_HOME}:tablist:1`;

g.upsertNavElement({
  id: NAV_BC, type: "nav-element", pageId: PAGE_PROJ, kind: "breadcrumb",
  inPageDomOrder: 0, containerAxId: AX_BC_NAV,
  memberAxIds: [AX_BC_HOME, AX_BC_PROJ], activeMemberAxId: null,
  name: "Breadcrumb", provenance: "html:parse",
});
g.upsertNavElement({
  id: NAV_MENU, type: "nav-element", pageId: PAGE_HOME, kind: "menu",
  inPageDomOrder: 0, containerAxId: AX_USER_MENU,
  memberAxIds: [AX_USER_MENU_I1, AX_USER_MENU_I2], activeMemberAxId: null,
  name: "User menu", provenance: "html:parse",
});
g.upsertNavElement({
  id: NAV_TABLIST, type: "nav-element", pageId: PAGE_HOME, kind: "tablist",
  inPageDomOrder: 1, containerAxId: AX_TABLIST,
  memberAxIds: [AX_TAB_RECENT, AX_TAB_ARCHIVED], activeMemberAxId: AX_TAB_RECENT,
  name: "Tabs", provenance: "html:parse",
});

// -- Cross-layer edges (PR-8a T4 / T5) --
g.upsertEdge({ id: `edge:${AX_USER_MENU}->${NAV_MENU}:menu-of`, type: "edge", from: AX_USER_MENU, to: NAV_MENU, kind: "menu-of", provenance: "html:parse" });
g.upsertEdge({ id: `edge:${AX_TABLIST}->${NAV_TABLIST}:menu-of`, type: "edge", from: AX_TABLIST, to: NAV_TABLIST, kind: "menu-of", provenance: "html:parse" });
g.upsertEdge({ id: `edge:${AX_TAB_RECENT}->${NAV_TABLIST}:tab-of`, type: "edge", from: AX_TAB_RECENT, to: NAV_TABLIST, kind: "tab-of", provenance: "html:parse" });
g.upsertEdge({ id: `edge:${AX_TAB_ARCHIVED}->${NAV_TABLIST}:tab-of`, type: "edge", from: AX_TAB_ARCHIVED, to: NAV_TABLIST, kind: "tab-of", provenance: "html:parse" });
g.upsertEdge({ id: `edge:${PAGE_HOME}->${PAGE_PROJ}:nav-link`, type: "edge", from: PAGE_HOME, to: PAGE_PROJ, kind: "nav-link", provenance: "html:hierarchy" });
g.upsertEdge({ id: `edge:${AX_TAB_RECENT}->state:TBD:${AX_TAB_RECENT}:apg-tab-activate:state:cause`, type: "edge", from: AX_TAB_RECENT, to: `state:TBD:${AX_TAB_RECENT}:apg-tab-activate`, kind: "state:cause", provenance: "html:parse" });

const { stop } = await startMcpServer(g, { name: "agent-web-graph", version: "0.1.0" });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
