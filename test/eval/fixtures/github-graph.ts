/**
 * Representative GitHub crawled Graph fixture for eval tests.
 */
import { Graph } from "../../../src/graph/graph.js";

const PAGE_ID = "page:github-repo";
const REPO_URL = "https://github.com/torvalds/linux/";

export function buildGitHubGraph(): Graph {
  const g = new Graph();

  // 1. Page
  g.upsertPage({
    id: PAGE_ID,
    type: "page",
    url: REPO_URL,
    title: "torvalds/linux: Linux kernel source tree",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "html:parser" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: REPO_URL,
    crawledAt: "2026-09-11T00:00:00.000Z",
    parentPageId: null,
  });

  // 2. Tabs
  const tabSpecs = [
    { id: "ax:tab-code", name: "Code", panel: "ax:panel-code" },
    { id: "ax:tab-issues", name: "Issues", panel: "ax:panel-issues" },
    { id: "ax:tab-pulls", name: "Pull requests", panel: "ax:panel-pulls" },
    { id: "ax:tab-discussions", name: "Discussions", panel: "ax:panel-discussions" },
    { id: "ax:tab-actions", name: "Actions", panel: "ax:panel-actions" },
    { id: "ax:tab-projects", name: "Projects", panel: "ax:panel-projects" },
    { id: "ax:tab-security", name: "Security", panel: "ax:panel-security" },
    { id: "ax:tab-insights", name: "Insights", panel: "ax:panel-insights" },
  ];

  let order = 1;
  for (const t of tabSpecs) {
    g.upsertAx({
      id: t.id,
      type: "ax-node",
      pageId: PAGE_ID,
      role: "tab",
      name: t.name,
      nameSource: "content",
      states: { expanded: null, disabled: null, pressed: null, selected: t.name === "Code", checked: null, busy: null, open: null, current: null },
      properties: {
        controls: [t.panel],
        describedBy: [],
        labelledBy: [],
        level: null,
        live: null,
        orientation: "horizontal",
        posInSet: order,
        setSize: tabSpecs.length,
        valueNow: null,
        valueMin: null,
        valueMax: null,
        valueText: null,
      },
      apgPattern: "tabs",
      focusable: true,
      visibility: "visible",
      inPageDomOrder: order++,
      parentAxId: "ax:tablist",
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
        controls: [],
        describedBy: [],
        labelledBy: [t.id],
        level: null,
        live: null,
        orientation: null,
        posInSet: null,
        setSize: null,
        valueNow: null,
        valueMin: null,
        valueMax: null,
        valueText: null,
      },
      apgPattern: "tabs",
      focusable: false,
      visibility: "visible",
      inPageDomOrder: order++,
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

  // 3. CTA Button (Sign up for GitHub)
  const ctaAxId = "ax:btn-signup";
  g.upsertAx({
    id: ctaAxId,
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "Sign up for GitHub",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    inPageDomOrder: 100,
    parentAxId: null,
    provenance: "html:parser",
  });
  g.upsertVisual({
    id: "vis:btn-signup",
    type: "visual-node",
    axId: ctaAxId,
    pageId: PAGE_ID,
    rect: { x: 1120, y: 16, w: 140, h: 36 },
    computedStyle: { backgroundColor: "rgb(35, 134, 54)", color: "rgb(255, 255, 255)" },
    designTokenRefs: ["color.btn.primary.bg"],
    tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
    provenance: "bidi:script.evaluate",
  });

  // 4. Capabilities (create_issue and create_pull_request)
  const issueAxId = "ax:btn-new-issue";
  g.upsertAx({
    id: issueAxId,
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "New issue",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    inPageDomOrder: 101,
    parentAxId: null,
    provenance: "html:parser",
  });
  g.upsertCapability({
    id: "cap:create_issue",
    type: "capability",
    name: "create_issue",
    description: "Create a new GitHub issue in the repository",
    inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } },
    outputSchema: { type: "object" },
    source: "webmcp",
    binding: { kind: "ax-node", axId: issueAxId, selector: "#new-issue" },
    security: "CONFIRM",
    provenance: "declared:schema",
    pageId: PAGE_ID,
  });

  const prAxId = "ax:btn-new-pr";
  g.upsertAx({
    id: prAxId,
    type: "ax-node",
    pageId: PAGE_ID,
    role: "button",
    name: "New pull request",
    nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: true,
    visibility: "visible",
    inPageDomOrder: 102,
    parentAxId: null,
    provenance: "html:parser",
  });
  g.upsertCapability({
    id: "cap:create_pull_request",
    type: "capability",
    name: "create_pull_request",
    description: "Create a new pull request",
    inputSchema: { type: "object", properties: { title: { type: "string" }, base: { type: "string" }, head: { type: "string" } } },
    outputSchema: { type: "object" },
    source: "webmcp",
    binding: { kind: "ax-node", axId: prAxId, selector: "#new-pr" },
    security: "CONFIRM",
    provenance: "declared:schema",
    pageId: PAGE_ID,
  });

  // 5. Sticky Top Header
  const headerAxId = "ax:gh-topbar";
  g.upsertAx({
    id: headerAxId,
    type: "ax-node",
    pageId: PAGE_ID,
    role: "navigation",
    name: "Global",
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null,
    focusable: false,
    visibility: "visible",
    inPageDomOrder: 0,
    parentAxId: null,
    provenance: "html:parser",
  });
  g.upsertVisual({
    id: "vis:gh-topbar",
    type: "visual-node",
    axId: headerAxId,
    pageId: PAGE_ID,
    rect: { x: 0, y: 0, w: 1280, h: 64 },
    computedStyle: { position: "sticky", backgroundColor: "rgb(36, 41, 47)" },
    designTokenRefs: ["color.header.bg"],
    tethers: {
      parent: null,
      children: ["vis:gh-logo", "vis:gh-search"],
      siblingsBefore: [],
      siblingsAfter: ["vis:main-content"],
      anchors: [],
    },
    provenance: "bidi:script.evaluate",
  });

  return g;
}

