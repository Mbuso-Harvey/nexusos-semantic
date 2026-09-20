/**
 * Tests for `relate` — the graph-traversal surface that `graph.path` now
 * dispatches to when a `relation` arg is present. Per ED-04 + the user
 * surface decision (2026-08-30), `graph.path` owns:
 *   children | parent | descendants | ancestors | path
 * The default (no relation) keeps the existing `findPath` behavior.
 */
import { describe, it, expect } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import { relate } from "../../src/graph/tools.js";
import type { AxNode, Edge, PageNode } from "../../src/graph/types.js";

/**
 * Build a small a11y tree:
 *   root
 *   ├── nav
 *   │   ├── a1
 *   │   └── a2
 *   └── main
 *       └── btn
 * 6 ax-nodes, 5 a11y:child-of edges (one for every non-root node).
 */
function buildTree(): Graph {
  const g = new Graph();
  const pageId = "page:home";
  g.upsertPage({
    id: pageId, type: "page", url: "https://example.com/", title: "T",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "aria:tree-walk" },
    viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
  });

  const ax = (overrides: Partial<AxNode> & { id: string; parentAxId: string | null }): AxNode => ({
    type: "ax-node", pageId, role: "generic", name: overrides.id, nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0,
    provenance: "aria:tree-walk",
    ...overrides,
  });

  const ids = {
    root: "ax:root", nav: "ax:nav", main: "ax:main",
    a1: "ax:a1", a2: "ax:a2", btn: "ax:btn",
  };
  g.upsertAx(ax({ id: ids.root, parentAxId: null, role: "region" }));
  g.upsertAx(ax({ id: ids.nav, parentAxId: ids.root, role: "navigation" }));
  g.upsertAx(ax({ id: ids.main, parentAxId: ids.root, role: "main" }));
  g.upsertAx(ax({ id: ids.a1, parentAxId: ids.nav, role: "link" }));
  g.upsertAx(ax({ id: ids.a2, parentAxId: ids.nav, role: "link" }));
  g.upsertAx(ax({ id: ids.btn, parentAxId: ids.main, role: "button", name: "Go", focusable: true }));

  // parent -> child edges (per ED-04: a11y:child-of goes parent -> child).
  const addChildOf = (parent: string, child: string) => {
    const e: Edge = {
      id: `edge:${parent}->${child}:a11y:child-of`,
      type: "edge", from: parent, to: child, kind: "a11y:child-of",
      provenance: "aria:tree-walk",
    };
    g.upsertEdge(e);
  };
  addChildOf(ids.root, ids.nav);
  addChildOf(ids.root, ids.main);
  addChildOf(ids.nav, ids.a1);
  addChildOf(ids.nav, ids.a2);
  addChildOf(ids.main, ids.btn);

  return g;
}

describe("relate — children", () => {
  it("returns immediate children in edge-from order", () => {
    const g = buildTree();
    const r = relate(g, "ax:root", "children");
    expect(r.relation).toBe("children");
    expect(r.nodes!.map((n) => n.id)).toEqual(["ax:nav", "ax:main"]);
  });

  it("returns [] for a leaf node", () => {
    const g = buildTree();
    const r = relate(g, "ax:a1", "children");
    expect(r.nodes).toEqual([]);
  });

  it("returns a non-existent node's empty result without throwing", () => {
    const g = buildTree();
    const r = relate(g, "ax:nope", "children");
    expect(r.nodes).toEqual([]);
  });
});

describe("relate — parent", () => {
  it("returns the single parent", () => {
    const g = buildTree();
    const r = relate(g, "ax:a1", "parent");
    expect(r.relation).toBe("parent");
    expect(r.parent?.id).toBe("ax:nav");
  });

  it("returns null for the document root", () => {
    const g = buildTree();
    const r = relate(g, "ax:root", "parent");
    expect(r.parent).toBeNull();
  });
});

describe("relate — descendants", () => {
  it("returns all descendants bounded by depth", () => {
    const g = buildTree();
    const r = relate(g, "ax:root", "descendants", { depth: 10 });
    expect(r.nodes!.map((n) => n.id).sort()).toEqual(
      ["ax:a1", "ax:a2", "ax:btn", "ax:main", "ax:nav"].sort(),
    );
  });

  it("depth=1 returns immediate children only", () => {
    const g = buildTree();
    const r = relate(g, "ax:root", "descendants", { depth: 1 });
    expect(r.nodes!.map((n) => n.id).sort()).toEqual(["ax:main", "ax:nav"].sort());
  });

  it("depth=2 captures all 5 nodes (the tree is only 2 levels deep)", () => {
    const g = buildTree();
    // depth=2 means "include nodes at distance <= 2 hops from root".
    // The tree is at most 2 hops deep, so every descendant is included.
    const r = relate(g, "ax:root", "descendants", { depth: 2 });
    expect(r.nodes!.map((n) => n.id).sort()).toEqual(
      ["ax:a1", "ax:a2", "ax:btn", "ax:main", "ax:nav"].sort(),
    );
  });

  it("returns [] for a leaf", () => {
    const g = buildTree();
    const r = relate(g, "ax:a1", "descendants", { depth: 5 });
    expect(r.nodes).toEqual([]);
  });

  it("depth defaults to 5 (the whole tree is 2 deep, so all 5 descendants show)", () => {
    const g = buildTree();
    const r = relate(g, "ax:root", "descendants");
    expect(r.nodes!.length).toBe(5);
  });

  it("depth is clamped to a maximum of 20", () => {
    const g = buildTree();
    // depth=100 should not loop (tree is 2 deep so it stops at 5 nodes)
    const r = relate(g, "ax:root", "descendants", { depth: 100 });
    expect(r.nodes!.length).toBe(5);
  });
});

describe("relate — ancestors", () => {
  it("returns all ancestors bounded by depth", () => {
    const g = buildTree();
    const r = relate(g, "ax:a1", "ancestors", { depth: 10 });
    expect(r.nodes!.map((n) => n.id)).toEqual(["ax:nav", "ax:root"]);
  });

  it("depth=1 returns the immediate parent only", () => {
    const g = buildTree();
    const r = relate(g, "ax:a1", "ancestors", { depth: 1 });
    expect(r.nodes!.map((n) => n.id)).toEqual(["ax:nav"]);
  });

  it("returns [] for the document root", () => {
    const g = buildTree();
    const r = relate(g, "ax:root", "ancestors", { depth: 5 });
    expect(r.nodes).toEqual([]);
  });
});

describe("relate — path (backward compatible)", () => {
  it("delegates to findPath when relation=path", () => {
    const g = buildTree();
    // root -> a1 is a direct a11y:child-of edge, so findPath finds it.
    const r = relate(g, "ax:root", "path", { to: "ax:a1" });
    expect(r.relation).toBe("path");
    expect(r.found).toBe(true);
    // root -> nav (1 hop) -> a1 (2 hops). The two-hop path uses
    // root->nav and nav->a1.
    expect(r.hops!.length).toBe(2);
    expect(r.cost).toBe(2);
  });

  it("returns not-found when disconnected (no outgoing path)", () => {
    // a1 has no outgoing a11y:child-of edges, so findPath from a1 to btn
    // cannot find a path without traversing edges in reverse.
    const g = buildTree();
    const r = relate(g, "ax:a1", "path", { to: "ax:btn" });
    expect(r.found).toBe(false);
  });

  it("returns not-found when the start node is unknown", () => {
    const g = new Graph();
    const r = relate(g, "ax:foo", "path", { to: "ax:bar" });
    expect(r.found).toBe(false);
  });
});

/**
 * ED-03 / T4: page-level traversal. The same `relate` surface
 * dispatches to nav:child-of edges + PageNode.parentPageId when the
 * from id starts with "page:". The default target is "ax-node" (PR-6
 * behavior); page-level traversal is inferred from the id prefix.
 *
 * Build a small nav hierarchy:
 *   page:/         (root, parentPageId=null)
 *   page:/a        (parent = page:/)
 *   page:/b        (parent = page:/)
 *   page:/a/x      (parent = page:/a)
 */
function buildNavGraph(): Graph {
  const g = new Graph();
  const mkPage = (id: string, parentPageId: string | null): PageNode => ({
    id, type: "page", url: id.replace(/^page:/, ""), title: id,
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: id.replace(/^page:/, ""), crawledAt: "t",
    parentPageId,
  });
  g.upsertPage(mkPage("page:/a", "page:/"));
  g.upsertPage(mkPage("page:/b", "page:/"));
  g.upsertPage(mkPage("page:/a/x", "page:/a"));
  g.upsertEdge({ id: "edge:page:/->page:/a:nav:child-of", type: "edge", from: "page:/", to: "page:/a", kind: "nav:child-of", provenance: "html:hierarchy" });
  g.upsertEdge({ id: "edge:page:/->page:/b:nav:child-of", type: "edge", from: "page:/", to: "page:/b", kind: "nav:child-of", provenance: "html:hierarchy" });
  g.upsertEdge({ id: "edge:page:/a->page:/a/x:nav:child-of", type: "edge", from: "page:/a", to: "page:/a/x", kind: "nav:child-of", provenance: "html:hierarchy" });
  return g;
}

describe("relate — page target (ED-03 / T4)", () => {
  it("children returns immediate child pages", () => {
    const g = buildNavGraph();
    // First insert the root page since buildNavGraph() skipped it (it
    // would have no parent in the graph; the orchestrator handles this
    // by leaving parentPageId null).
    g.upsertPage({
      id: "page:/", type: "page", url: "https://example.com/", title: "root",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null,
      screenshotRef: null, canonicalUrl: "https://example.com/", crawledAt: "t",
      parentPageId: null,
    });
    const r = relate(g, "page:/", "children");
    expect(r.target).toBe("page");
    expect(r.nodes!.map((n) => n.id).sort()).toEqual(["page:/a", "page:/b"].sort());
  });

  it("parent returns the single parent page", () => {
    const g = buildNavGraph();
    const r = relate(g, "page:/a/x", "parent");
    expect(r.target).toBe("page");
    expect(r.parent?.id).toBe("page:/a");
  });

  it("descendants returns the subtree bounded by depth", () => {
    const g = buildNavGraph();
    g.upsertPage({
      id: "page:/", type: "page", url: "https://example.com/", title: "root",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null,
      screenshotRef: null, canonicalUrl: "https://example.com/", crawledAt: "t",
      parentPageId: null,
    });
    const r = relate(g, "page:/", "descendants", { depth: 5 });
    expect(r.target).toBe("page");
    expect(r.nodes!.map((n) => n.id).sort()).toEqual(
      ["page:/a", "page:/a/x", "page:/b"].sort(),
    );
  });

  it("ancestors returns the chain of parent pages", () => {
    const g = buildNavGraph();
    g.upsertPage({
      id: "page:/", type: "page", url: "https://example.com/", title: "root",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null,
      screenshotRef: null, canonicalUrl: "https://example.com/", crawledAt: "t",
      parentPageId: null,
    });
    const r = relate(g, "page:/a/x", "ancestors", { depth: 5 });
    expect(r.target).toBe("page");
    expect(r.nodes!.map((n) => n.id)).toEqual(["page:/a", "page:/"]);
  });

  it("path does shortest-path BFS over nav:child-of edges", () => {
    const g = buildNavGraph();
    g.upsertPage({
      id: "page:/", type: "page", url: "https://example.com/", title: "root",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null,
      screenshotRef: null, canonicalUrl: "https://example.com/", crawledAt: "t",
      parentPageId: null,
    });
    const r = relate(g, "page:/b", "path", { to: "page:/a/x" });
    expect(r.target).toBe("page");
    expect(r.found).toBe(false); // /b and /a/x are in different subtrees
  });

  it("without an explicit target, the dispatch is inferred from the id prefix", () => {
    const g = buildNavGraph();
    // No need to add the root since /a/x has a real parent.
    const r = relate(g, "page:/a/x", "parent");
    expect(r.target).toBe("page");
    expect(r.parent?.id).toBe("page:/a");
  });

  it("depth is clamped to max 20 on the page target", () => {
    const g = buildNavGraph();
    g.upsertPage({
      id: "page:/", type: "page", url: "https://example.com/", title: "root",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null,
      screenshotRef: null, canonicalUrl: "https://example.com/", crawledAt: "t",
      parentPageId: null,
    });
    // depth: 100 should not loop; the graph is 2 levels deep so it
    // stops at all 3 descendants.
    const r = relate(g, "page:/", "descendants", { depth: 100 });
    expect(r.nodes!.length).toBe(3);
  });
});

// PR-8a: nav-level relations on the page dispatch. These relations
// expose Layer 1 *participation* (menus, tablists, breadcrumbs,
// nav-links) on the same `graph.path` surface. The dispatch routes
// through relatePage regardless of the `from` id prefix.
describe("relate — PR-8a nav-level relations", () => {
  /**
   * Build a 2-page graph with:
   *  - one breadcrumb NavElement (container = "ax:bc-nav")
   *  - one tablist NavElement (container = "ax:tablist", 3 members)
   *  - one menu NavElement (container = "ax:menu", 2 members)
   *  - one page-to-page nav-link edge from A -> B
   */
  function buildNavLevel(): { g: Graph; pageA: string; pageB: string; breadcrumbItems: string[]; tablistMembers: string[]; menuMembers: string[] } {
    const g = new Graph();
    const pageA = "page:https://example.com/a";
    const pageB = "page:https://example.com/b";
    g.upsertPage({
      id: pageA, type: "page", url: "https://example.com/a", title: "A",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
      canonicalUrl: "https://example.com/a", crawledAt: "t", parentPageId: null,
    });
    g.upsertPage({
      id: pageB, type: "page", url: "https://example.com/b", title: "B",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:b-root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
      canonicalUrl: "https://example.com/b", crawledAt: "t", parentPageId: null,
    });

    // Nav-link edge A -> B (page-to-page, page-to-page).
    g.upsertEdge({
      id: `edge:${pageA}->${pageB}:nav-link`,
      type: "edge", from: pageA, to: pageB, kind: "nav-link",
      provenance: "html:hierarchy",
    });

    // Page-A ax-nodes: breadcrumb container + 3 items; tablist + 3 tabs;
    // menu + 2 items. axId format is `ax:<pageId>:<rest>`.
    const ax = (id: string, name: string, role: string): AxNode => ({
      type: "ax-node", pageId: pageA, id, name, nameSource: "content", role: role as AxNode["role"],
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null,
      provenance: "html:t",
    });
    const bcNavId = `ax:${pageA}:bc-nav`;
    const bc1Id = `ax:${pageA}:bc-1`;
    const bc2Id = `ax:${pageA}:bc-2`;
    const bc3Id = `ax:${pageA}:bc-3`;
    const tablistId = `ax:${pageA}:tablist`;
    const tab1Id = `ax:${pageA}:tab-1`;
    const tab2Id = `ax:${pageA}:tab-2`;
    const tab3Id = `ax:${pageA}:tab-3`;
    const menuId = `ax:${pageA}:menu`;
    const menu1Id = `ax:${pageA}:menu-1`;
    const menu2Id = `ax:${pageA}:menu-2`;
    g.upsertAx(ax(bcNavId, "Breadcrumb", "navigation"));
    g.upsertAx(ax(bc1Id, "Home", "link"));
    g.upsertAx(ax(bc2Id, "Docs", "link"));
    g.upsertAx(ax(bc3Id, "Current", "link"));
    g.upsertAx(ax(tablistId, "Tabs", "tablist"));
    g.upsertAx(ax(tab1Id, "Recent", "tab"));
    g.upsertAx(ax(tab2Id, "Popular", "tab"));
    g.upsertAx(ax(tab3Id, "Archived", "tab"));
    g.upsertAx(ax(menuId, "User menu", "menu"));
    g.upsertAx(ax(menu1Id, "Profile", "menuitem"));
    g.upsertAx(ax(menu2Id, "Sign out", "menuitem"));

    // NavElements.
    g.upsertNavElement({
      id: `nav:${pageA}:breadcrumb:0`, type: "nav-element", pageId: pageA,
      kind: "breadcrumb", inPageDomOrder: 0, containerAxId: bcNavId,
      memberAxIds: [bc1Id, bc2Id, bc3Id],
      activeMemberAxId: null, name: "Breadcrumb", provenance: "html:parse",
    });
    g.upsertNavElement({
      id: `nav:${pageA}:tablist:0`, type: "nav-element", pageId: pageA,
      kind: "tablist", inPageDomOrder: 1, containerAxId: tablistId,
      memberAxIds: [tab1Id, tab2Id, tab3Id],
      activeMemberAxId: tab2Id, name: "Tabs", provenance: "html:parse",
    });
    g.upsertNavElement({
      id: `nav:${pageA}:menu:0`, type: "nav-element", pageId: pageA,
      kind: "menu", inPageDomOrder: 2, containerAxId: menuId,
      memberAxIds: [menu1Id, menu2Id],
      activeMemberAxId: null, name: "User menu", provenance: "html:parse",
    });

    // tab-of edges from each tab to the tablist NavElement.
    for (const tab of [tab1Id, tab2Id, tab3Id]) {
      g.upsertEdge({
        id: `edge:${tab}->nav:${pageA}:tablist:0:tab-of`,
        type: "edge", from: tab, to: `nav:${pageA}:tablist:0`, kind: "tab-of",
        provenance: "html:parse",
      });
    }

    return { g, pageA, pageB, breadcrumbItems: [bc1Id, bc2Id, bc3Id], tablistMembers: [tab1Id, tab2Id, tab3Id], menuMembers: [menu1Id, menu2Id] };
  }

  it("nav-links: returns the pages reachable from a source page via nav-link edges", () => {
    const { g, pageA, pageB } = buildNavLevel();
    const r = relate(g, pageA, "nav-links");
    expect(r.relation).toBe("nav-links");
    expect(r.target).toBe("page");
    expect(r.nodes!.map((n) => n.id)).toEqual([pageB]);
  });

  it("nav-links: returns [] for a page with no outgoing nav-link edges", () => {
    const { g, pageB } = buildNavLevel();
    const r = relate(g, pageB, "nav-links");
    expect(r.nodes).toEqual([]);
  });

  it("breadcrumbs: returns the breadcrumb NavElement + ordered members", () => {
    const { g, breadcrumbItems, pageA } = buildNavLevel();
    const containerId = `ax:${pageA}:bc-nav`;
    const r = relate(g, containerId, "breadcrumbs");
    expect(r.relation).toBe("breadcrumbs");
    expect(r.target).toBe("page");
    // First node is the NavElement itself.
    const navEl = r.nodes![0] as { id: string; kind: string };
    expect(navEl.kind).toBe("breadcrumb");
    // Following entries are the resolved ax-nodes in trail order.
    const items = r.nodes!.slice(1).map((n: any) => n.id);
    expect(items).toEqual(breadcrumbItems);
  });

  it("menu: returns the menu NavElement + member ax-nodes", () => {
    const { g, menuMembers, pageA } = buildNavLevel();
    const containerId = `ax:${pageA}:menu`;
    const r = relate(g, containerId, "menu");
    expect(r.relation).toBe("menu");
    const navEl = r.nodes![0] as { id: string; kind: string };
    expect(navEl.kind).toBe("menu");
    const members = r.nodes!.slice(1).map((n: any) => n.id);
    expect(members).toEqual(menuMembers);
  });

  it("tab-of: returns the containing tablist NavElement for a tab axId", () => {
    const { g, pageA } = buildNavLevel();
    const tabId = `ax:${pageA}:tab-1`;
    const r = relate(g, tabId, "tab-of");
    expect(r.relation).toBe("tab-of");
    // First node is the tablist NavElement, last is the tab ax-node
    // (so the result is self-describing).
    const navEl = r.nodes!.find((n: any) => n.kind === "tablist") as { id: string; kind: string };
    expect(navEl).toBeTruthy();
    expect(navEl.kind).toBe("tablist");
    // The tab itself appears too.
    const tab = r.nodes!.find((n: any) => n.id === tabId);
    expect(tab).toBeTruthy();
  });

  it("tab-of: works from any tab in the same tablist", () => {
    const { g, pageA } = buildNavLevel();
    for (const suffix of ["tab-1", "tab-2", "tab-3"]) {
      const r = relate(g, `ax:${pageA}:${suffix}`, "tab-of");
      const navEl = r.nodes!.find((n: any) => n.kind === "tablist");
      expect(navEl).toBeTruthy();
    }
  });

  it("nav-level relations: return [] when there is no match", () => {
    const { g, pageA } = buildNavLevel();
    // A breadcrumb item, not a container.
    const r = relate(g, `ax:${pageA}:bc-1`, "breadcrumbs");
    expect(r.nodes).toEqual([]);
    // A tab, not a menu container.
    const r2 = relate(g, `ax:${pageA}:tab-1`, "menu");
    expect(r2.nodes).toEqual([]);
  });

  it("nav-level relations: page target still works for children/parent/descendants (backward compat)", () => {
    const g = new Graph();
    g.upsertPage({
      id: "page:https://example.com/", type: "page", url: "https://example.com/", title: "R",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:r", provenance: "html:t" },
      viewport: { w: 1, h: 1, dpr: 1 }, tokensOverride: null, screenshotRef: null,
      canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
    });
    g.upsertPage({
      id: "page:https://example.com/x", type: "page", url: "https://example.com/x", title: "X",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:x", provenance: "html:t" },
      viewport: { w: 1, h: 1, dpr: 1 }, tokensOverride: null, screenshotRef: null,
      canonicalUrl: "https://example.com/x", crawledAt: "t", parentPageId: null,
    });
    g.upsertEdge({
      id: "edge:page:https://example.com/->page:https://example.com/x:nav:child-of",
      type: "edge", from: "page:https://example.com/", to: "page:https://example.com/x",
      kind: "nav:child-of", provenance: "html:hierarchy",
    });
    const r = relate(g, "page:https://example.com/", "children");
    expect(r.nodes!.map((n) => n.id)).toEqual(["page:https://example.com/x"]);
  });
});

// ====================================================================
// PR-8: state-level traversal. The Interaction/State Graph is a
// directed reachability graph, NOT a tree (per ED-01 req #6), so
// children/parent/descendants/ancestors are not exposed. Only
// successors / predecessors / reachable / path are supported.
// ====================================================================

function buildStateGraph(): { g: Graph; ids: { closed: string; open: string; profile: string; menu: string } } {
  const g = new Graph();
  const pageId = "page:https://example.com/";
  g.upsertPage({
    id: pageId, type: "page", url: pageId, title: "P",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:r", provenance: "aria:tree-walk" },
    viewport: { w: 1, h: 1, dpr: 1 }, tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
  });
  function makeState(route: string, label: string): any {
    return {
      id: `state:${label}`,
      type: "state" as const,
      pageId, payload: {
        pageId, route, auth: { kind: "anonymous" as const },
        network: { status: "online" as const, evidence: "static" as const },
        elements: {}, focusedAxId: null,
        openDialogIds: [], openPopoverIds: [],
        expandedRegionAxIds: [],
        viewport: { w: 1, h: 1, dpr: 1, scrollX: 0, scrollY: 0 },
        conditionalMarkers: {},
      },
      visualFingerprint: `vp:${label}`,
      authContext: { kind: "anonymous" as const },
      networkContext: { status: "online" as const, evidence: "static" as const },
      provenance: "dom-diff:probe" as const,
      firstObservedAt: "t",
      evidence: [{ kind: "observed" as const, sourceAxId: "ax:1", transitionId: null, at: "t" }],
    };
  }
  const closed = makeState("/", "closed");
  const open = makeState("/", "open");
  const profile = makeState("/", "profile");
  const menu = makeState("/", "menu");
  g.upsertState(closed);
  g.upsertState(open);
  g.upsertState(profile);
  g.upsertState(menu);
  g.upsertEdge({
    id: "edge:closed->open:state:successor", type: "edge", kind: "state:successor",
    from: closed.id, to: open.id, provenance: "dom-diff:probe",
    triggers: ["click"],
  });
  g.upsertEdge({
    id: "edge:open->menu:state:successor", type: "edge", kind: "state:successor",
    from: open.id, to: menu.id, provenance: "dom-diff:probe",
    triggers: ["hover"],
  });
  g.upsertEdge({
    id: "edge:open->profile:state:successor", type: "edge", kind: "state:successor",
    from: open.id, to: profile.id, provenance: "dom-diff:probe",
    triggers: ["click"],
  });
  return {
    g,
    ids: { closed: closed.id, open: open.id, profile: profile.id, menu: menu.id },
  };
}

describe("relate (state target, PR-8)", () => {
  it("successors returns 1-hop outgoing state:successor edges", () => {
    const { g, ids } = buildStateGraph();
    const r = relate(g, ids.closed, "successors");
    expect(r.target).toBe("state");
    expect(r.nodes!.map((n) => n.id)).toEqual([ids.open]);
  });

  it("predecessors returns 1-hop incoming state:successor edges", () => {
    const { g, ids } = buildStateGraph();
    const r = relate(g, ids.open, "predecessors");
    expect(r.target).toBe("state");
    expect(r.nodes!.map((n) => n.id)).toEqual([ids.closed]);
  });

  it("reachable does BFS to depth (default 5)", () => {
    const { g, ids } = buildStateGraph();
    const r = relate(g, ids.closed, "reachable");
    expect(r.target).toBe("state");
    expect(r.nodes!.map((n) => n.id).sort()).toEqual(
      [ids.open, ids.menu, ids.profile].sort(),
    );
  });

  it("reachable respects depth limit", () => {
    const { g, ids } = buildStateGraph();
    const r = relate(g, ids.closed, "reachable", { depth: 1 });
    expect(r.nodes!.map((n) => n.id)).toEqual([ids.open]);
  });

  it("path finds the shortest state-to-state path", () => {
    const { g, ids } = buildStateGraph();
    const r = relate(g, ids.closed, "path", { to: ids.menu });
    expect(r.found).toBe(true);
    expect(r.cost).toBe(2);
    expect(r.hops!.map((h) => h.via)).toEqual(["state:successor", "state:successor"]);
  });

  it("path returns found:false when no path exists", () => {
    const g = new Graph();
    g.upsertState({
      id: "state:lonely", type: "state", pageId: "p", payload: {} as any,
      visualFingerprint: "vp:lonely", authContext: { kind: "anonymous" } as any,
      networkContext: { status: "online", evidence: "static" } as any,
      provenance: "dom-diff:probe", firstObservedAt: "t", evidence: [],
    });
    g.upsertState({
      id: "state:other", type: "state", pageId: "p", payload: {} as any,
      visualFingerprint: "vp:other", authContext: { kind: "anonymous" } as any,
      networkContext: { status: "online", evidence: "static" } as any,
      provenance: "dom-diff:probe", firstObservedAt: "t", evidence: [],
    });
    const r = relate(g, "state:lonely", "path", { to: "state:other" });
    expect(r.found).toBe(false);
    expect(r.cost).toBe(-1);
  });

  it("tree-style relations (children/parent/descendants/ancestors) are rejected for state", () => {
    const { g, ids } = buildStateGraph();
    for (const rel of ["children", "parent", "descendants", "ancestors"] as const) {
      const r = relate(g, ids.closed, rel);
      expect(r.target).toBe("state");
      expect(r.nodes).toEqual([]);
    }
  });

  it("infers the state target from a `state:`-prefixed id", () => {
    const { g, ids } = buildStateGraph();
    const r = relate(g, ids.closed, "successors");
    expect(r.target).toBe("state");
  });
});
