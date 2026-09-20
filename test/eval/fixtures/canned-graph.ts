/**
 * Canned in-memory Graph fixture for eval tests.
 *
 * 15-node single-page demo that exercises every eval task:
 *   - 1 page (HOME)
 *   - 3 tabs (Recent / Popular / Archived) with aria-controls edges to 3 tabpanels
 *   - 1 home-page "New ticket" button (visual node references color.accent)
 *   - 1 secondary "Search docs" button (no color.accent, for task 2 negative case)
 *   - 1 "theme-toggle" button (custom invoker for task 4)
 *   - 1 capability `create_ticket` bound to the "New ticket" button
 *   - 1 capability `search_docs` bound to the "Search docs" button
 *   - 1 capability `delete_workspace` (does not match task 3 pattern)
 *   - 1 visual node with position: sticky (the topbar) for task 5
 *
 * Every test that needs a graph can `buildCannedGraph()` and get a fresh copy.
 */
import { Graph } from "../../../src/graph/graph.js";

const PAGE_ID = "page:home";
const HOME_URL = "http://example.test/";

export function buildCannedGraph(): Graph {
  const g = new Graph();

  // ----- Page -----
  g.upsertPage({
    id: PAGE_ID,
    type: "page",
    url: HOME_URL,
    title: "Test Home",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "html:parser" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: HOME_URL,
    crawledAt: "2026-01-01T00:00:00.000Z", parentPageId: null,
  });

  // ----- Tabs (3) with their panels (3) -----
  const tabSpec = [
    { id: "ax:tab-recent",  name: "Recent",  panel: "ax:panel-recent" },
    { id: "ax:tab-popular", name: "Popular", panel: "ax:panel-popular" },
    { id: "ax:tab-archived",name: "Archived",panel: "ax:panel-archived" },
  ];
  let order = 1;
  for (const t of tabSpec) {
    g.upsertAx({
      id: t.id,
      type: "ax-node",
      pageId: PAGE_ID,
      role: "tab",
      name: t.name,
      nameSource: "content",
      states: { expanded: null, disabled: null, pressed: null, selected: false, checked: null, busy: null, open: null, current: null },
      properties: {
        controls: [t.panel], describedBy: [], labelledBy: [],
        level: null, live: null, orientation: "horizontal",
        posInSet: order, setSize: 3,
        valueNow: null, valueMin: null, valueMax: null, valueText: null,
      },
      apgPattern: "tabs",
      focusable: true, visibility: "visible", inPageDomOrder: order++,
      parentAxId: null,
      provenance: "html:parser",
    });
    g.upsertAx({
      id: t.panel,
      type: "ax-node",
      pageId: PAGE_ID,
      role: "tabpanel",
      name: `${t.name} panel`,
      nameSource: "aria-label",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: {
        controls: [], describedBy: [], labelledBy: [t.id],
        level: null, live: null, orientation: null,
        posInSet: null, setSize: null,
        valueNow: null, valueMin: null, valueMax: null, valueText: null,
      },
      apgPattern: "tabs",
      focusable: false, visibility: "visible", inPageDomOrder: 0,
      parentAxId: null,
      provenance: "html:parser",
    });
    g.upsertEdge({
      id: `edge:${t.id}->${t.panel}:aria-controls`,
      type: "edge",
      from: t.id,
      to: t.panel,
      kind: "aria-controls",
      provenance: "html:parser",
    });
  }

  // ----- Home-page buttons -----
  g.upsertAx({
    id: "ax:new-ticket",
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "New ticket",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: {
      controls: [], describedBy: [], labelledBy: [],
      level: null, live: null, orientation: null,
      posInSet: null, setSize: null,
      valueNow: null, valueMin: null, valueMax: null, valueText: null,
    },
    apgPattern: null,
    focusable: true, visibility: "visible", inPageDomOrder: 10,
    parentAxId: null,
    provenance: "html:parser",
  });
  g.upsertVisual({
    id: "vis:new-ticket",
    type: "visual-node",
    axId: "ax:new-ticket",
    pageId: PAGE_ID,
    rect: { x: 0, y: 0, w: 120, h: 40 },
    computedStyle: {
      backgroundColor: "rgb(0, 102, 204)",
      color: "rgb(255, 255, 255)",
      padding: "8px 16px",
      position: "static",
    },
    designTokenRefs: [
      "radius.sm",
      "space.1",
      "color.bg",
      "color.accent",
      "font.family.sans",
      "font.size.sm",
      "font.weight.medium",
    ],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.evaluate",
  });

  g.upsertAx({
    id: "ax:search-docs",
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "Search docs",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: {
      controls: [], describedBy: [], labelledBy: [],
      level: null, live: null, orientation: null,
      posInSet: null, setSize: null,
      valueNow: null, valueMin: null, valueMax: null, valueText: null,
    },
    apgPattern: null,
    focusable: true, visibility: "visible", inPageDomOrder: 11,
    parentAxId: null,
    provenance: "html:parser",
  });
  g.upsertVisual({
    id: "vis:search-docs",
    type: "visual-node",
    axId: "ax:search-docs",
    pageId: PAGE_ID,
    rect: { x: 0, y: 50, w: 100, h: 32 },
    computedStyle: { backgroundColor: "rgb(240,240,240)", color: "rgb(0,0,0)" },
    designTokenRefs: ["color.muted"],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.evaluate",
  });

  g.upsertAx({
    id: "ax:theme-toggle",
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "Toggle theme",
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: false, selected: null, checked: null, busy: null, open: null, current: null },
    properties: {
      controls: [], describedBy: [], labelledBy: [],
      level: null, live: null, orientation: null,
      posInSet: null, setSize: null,
      valueNow: null, valueMin: null, valueMax: null, valueText: null,
    },
    apgPattern: null,
    focusable: true, visibility: "visible", inPageDomOrder: 12,
    parentAxId: null,
    provenance: "html:parser",
  });

  // ----- Sticky topbar (visual-only; no ax) for task 5 -----
  g.upsertVisual({
    id: "vis:topbar",
    type: "visual-node",
    axId: "ax:theme-toggle", // tether to the toggle so it's not orphaned
    pageId: PAGE_ID,
    rect: { x: 0, y: 0, w: 1280, h: 56 },
    computedStyle: {
      position: "sticky",
      top: "0px",
      zIndex: "10",
      backgroundColor: "rgb(255, 255, 255)",
    },
    designTokenRefs: ["color.bg"],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.evaluate",
  });

  // ----- Capabilities -----
  g.upsertCapability({
    id: "cap:create_ticket:0",
    type: "capability",
    name: "create_ticket",
    description: "Open a new support ticket.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    outputSchema: { type: "object" },
    source: "webmcp",
    binding: { kind: "ax-node", axId: "ax:new-ticket", selector: "#new-ticket" },
    security: "EXECUTE",
    provenance: "bidi:script.evaluate",
    pageId: PAGE_ID,
  });
  g.upsertCapability({
    id: "cap:search_docs:0",
    type: "capability",
    name: "search_docs",
    description: "Search the knowledge base.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    source: "webmcp",
    binding: { kind: "ax-node", axId: "ax:search-docs", selector: "#search-docs" },
    security: "READ",
    provenance: "bidi:script.evaluate",
    pageId: PAGE_ID,
  });
  g.upsertCapability({
    id: "cap:delete_workspace:0",
    type: "capability",
    name: "delete_workspace",
    description: "Permanently delete the workspace.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    source: "webmcp",
    binding: { kind: "ax-node", axId: "ax:new-ticket", selector: "#delete" },
    security: "CONFIRM",
    provenance: "bidi:script.evaluate",
    pageId: PAGE_ID,
  });

  return g;
}

export const CANNED_PAGE_ID = PAGE_ID;
export const CANNED_HOME_URL = HOME_URL;
