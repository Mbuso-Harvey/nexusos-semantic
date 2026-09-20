/**
 * Unit tests for the crawler orchestrator's pure pieces: URL canonicalization,
 * scope checks, and the BFS order driven by extractor-supplied links.
 * No BiDi required.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Crawler, DEFAULT_EXTRACTORS } from "../../src/crawler/orchestrator.js";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode } from "../../src/graph/types.js";
import { WALKER_FN, type WalkResult, type AxTreeNode } from "../../src/extract-structure/structural.js";

describe("Crawler.canonicalize", () => {
  it("drops the hash fragment", () => {
    expect(Crawler.canonicalize("https://example.com/a#b")).toBe("https://example.com/a");
  });

  it("strips a trailing slash from non-root paths", () => {
    expect(Crawler.canonicalize("https://example.com/about/")).toBe("https://example.com/about");
    expect(Crawler.canonicalize("https://example.com/")).toBe("https://example.com/");
  });

  it("sorts query params so ?a=1&b=2 and ?b=2&a=1 dedup to the same URL", () => {
    expect(Crawler.canonicalize("https://example.com/x?a=1&b=2"))
      .toBe(Crawler.canonicalize("https://example.com/x?b=2&a=1"));
  });

  it("returns the input unchanged for garbage URLs", () => {
    expect(Crawler.canonicalize("not a url")).toBe("not a url");
  });
});

describe("Crawler.inScope", () => {
  let g: Graph;
  beforeEach(() => { g = new Graph(); });

  it("same-origin keeps only matching origin", () => {
    const c = new Crawler(g, { rootUrl: "https://example.com/", scope: "same-origin" });
    expect(c.inScope("https://example.com/", "https://example.com/about")).toBe(true);
    expect(c.inScope("https://example.com/", "https://other.com/x")).toBe(false);
  });

  it("same-site matches eTLD+1 but not unrelated hosts", () => {
    const c = new Crawler(g, { rootUrl: "https://docs.example.com/", scope: "same-site" });
    expect(c.inScope("https://docs.example.com/", "https://api.example.com/x")).toBe(true);
    expect(c.inScope("https://docs.example.com/", "https://example.com/")).toBe(true);
    expect(c.inScope("https://docs.example.com/", "https://notexample.com/")).toBe(false);
  });

  it("any accepts every URL", () => {
    const c = new Crawler(g, { rootUrl: "https://example.com/", scope: "any" });
    expect(c.inScope("https://example.com/", "https://other.com/")).toBe(true);
  });
});

describe("Crawler BFS — orchestrator drives extractors and dedups", () => {
  /**
   * Minimal in-memory Page stub.
   *
   * NOTE on walker shapes (audit finding F7): by default `callFunction`
   * returns discovery-shaped records for *every* walker call, so the
   * structural walker cannot find `.root` and reports `produced: false`.
   * That is deliberate — it keeps this BFS/budget/dedup suite decoupled from
   * the structural extractor's own (separately and thoroughly tested) DOM
   * behaviour, and the empty-graph diagnostic that results is pinned by
   * `records a diagnostic when the structural walker produces no
   * accessibility tree`. Tests that need a *realistic* structural success
   * path pass `axTree`, and this stub then returns a spec-shaped
   * `WalkResult` for the genuine `WALKER_FN` only.
   */
  function makeMockPage(overrides: Partial<{ url: string; title: string; outLinks: string[]; axTree: WalkResult }> = {}) {
    const outLinks = overrides.outLinks ?? [];
    return {
      url: Promise.resolve(overrides.url ?? "https://example.com/"),
      title: Promise.resolve(overrides.title ?? "T"),
      target: { context: "ctx" } as any,
      navigate: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      script: {
        evaluate: vi.fn(async (_t: any, src: string) => {
          if (src.includes("querySelector('h1")) return "Hello";
          if (src.includes("querySelectorAll('[role]")) return 5;
          if (src.includes("getBoundingClientRect")) return [];
          if (src.includes("popovertarget")) return [];
          if (src.includes("querySelectorAll('a[href]")) return outLinks;
          if (src.includes("querySelectorAll('button, a, [role=button]")) return 0;
          if (src.includes("querySelectorAll('*'))")) return 0;
          return null;
        }),
        callFunction: vi.fn(async (_t: any, fn: string, _args: any[]) => {
          // The real structural walker is identified by its own source, so a
          // test can opt into a genuine accessibility tree without affecting
          // the discovery path.
          if (overrides.axTree !== undefined && (fn === WALKER_FN || fn.includes("TreeWalker"))) {
            return overrides.axTree;
          }
          // The discovery walker emits a DiscoveryLinkRecord per link;
          // tests that don't care about edges can pass plain hrefs and
          // the mock synthesizes same-origin records for them.
          return outLinks.map((href) => ({
            fromAxId: `ax:page:href:${href}`,
            toAxId: `ax:page:href:${href}`,
            kind: "link",
            href,
            rawHref: href,
            isExternal: false,
            isAnchor: false,
            isJs: false,
          }));
        }),
      },
    } as any;
  }

  /** Build a spec-shaped AxTreeNode for the mock walker payload. */
  function axNode(over: Partial<Record<string, unknown>> = {}): any {
    return {
      domOrder: 0,
      tag: "body",
      elementId: null,
      role: "document",
      name: "",
      nameSource: "content",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null,
      focusable: false,
      visibility: "visible",
      children: [],
      ...over,
    };
  }

  function makeMockSession(pages: any[]) {
    return {
      newPage: vi.fn(async () => pages.shift() ?? makeMockPage()),
      close: vi.fn(async () => undefined),
    } as any;
  }

  it("visits the root, runs every extractor, and follows outbound links", async () => {
    const g = new Graph();
    const rootPage = makeMockPage({ url: "https://example.com/", outLinks: ["https://example.com/a", "https://example.com/b"] });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: [] });
    const pageB = makeMockPage({ url: "https://example.com/b", outLinks: ["https://example.com/a"] /* cycle */ });
    const session = makeMockSession([rootPage, pageA, pageB]);

    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      budget: { maxPages: 10, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
      session,
    });
    const r = await c.crawl();
    expect(r.pages).toBe(3);
    expect(g.pageCount).toBe(3);
    // dedup: the cycle from /b back to /a must not re-enqueue /a
    expect(g.getPage("page:https://example.com/")).toBeDefined();
    expect(g.getPage("page:https://example.com/a")).toBeDefined();
    expect(g.getPage("page:https://example.com/b")).toBeDefined();
  });

  it("respects maxPages budget and stops when reached", async () => {
    const g = new Graph();
    const pages = Array.from({ length: 10 }, (_, i) => makeMockPage({
      url: `https://example.com/p${i}`,
      outLinks: i < 9 ? [`https://example.com/p${i + 1}`] : [],
    }));
    const session = makeMockSession(pages);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/p0",
      budget: { maxPages: 3, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
      session,
    });
    const r = await c.crawl();
    expect(r.pages).toBe(3);
    expect(g.pageCount).toBe(3);
  });

  it("out-of-scope links are not enqueued", async () => {
    const g = new Graph();
    const rootPage = makeMockPage({
      url: "https://example.com/",
      outLinks: ["https://other.com/x", "https://example.com/a"],
    });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: [] });
    const session = makeMockSession([rootPage, pageA]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      scope: "same-origin",
      session,
    });
    const r = await c.crawl();
    expect(r.pages).toBe(2);
    expect(g.getPage("page:https://other.com/x")).toBeUndefined();
    expect(g.getPage("page:https://example.com/a")).toBeDefined();
  });

  it("runs all default extractors in order on each page", async () => {
    const g = new Graph();
    const rootPage = makeMockPage();
    const session = makeMockSession([rootPage]);
    const order: string[] = [];
    const ext = DEFAULT_EXTRACTORS.map((e) => ({
      name: e.name,
      run: async () => { order.push(e.name); return { produced: false, durationMs: 0 }; },
    }));
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      extractors: ext,
      session,
    });
    await c.crawl();
    expect(order).toEqual(["structure", "visual", "state-declared", "state-observed", "behavior", "discovery"]);
  });

  it("continues past a failing extractor (does not abort the crawl)", async () => {
    const g = new Graph();
    const rootPage = makeMockPage();
    const session = makeMockSession([rootPage]);
    const ext = [
      { name: "boom", run: async () => { throw new Error("nope"); } },
      { name: "after", run: async () => ({ produced: true, durationMs: 0 }) },
    ];
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      extractors: ext as any,
      session,
    });
    const r = await c.crawl();
    expect(r.pages).toBe(1);
    expect(g.getDiagnostics().extractorFailures).toHaveLength(1);
    expect(g.getDiagnostics().extractorFailures[0]?.extractor).toBe("boom");
    expect(g.getDiagnostics().extractorFailures[0]?.error).toBe("nope");
  });

  it("records a diagnostic when the structural walker produces no accessibility tree (audit F7)", async () => {
    const g = new Graph();
    const session = makeMockSession([makeMockPage()]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    const failures = g.getDiagnostics().extractorFailures;
    // The mock's `script.callFunction` returns discovery-shaped records for
    // every walker, so the structural walker cannot find `.root` and reports
    // `produced: false`. Before audit finding F7 was fixed this was only a
    // log line and the page was persisted with zero AxNodes, indistinguishably
    // from a successfully-extracted empty page.
    const structural = failures.filter((f) => f.extractor === "structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.error).toMatch(/no accessibility tree/);
    expect(structural[0]?.pageId).toBe("page:https://example.com/");
    // The page itself still loaded — an empty tree is an extraction
    // diagnostic, not a page error.
    expect(g.getPage("page:https://example.com/")?.loadStatus).toBe("complete");
    expect(g.getDiagnostics().pageErrors).toHaveLength(0);
  });

  it("does not record a structural diagnostic when the extractor list omits 'structure'", async () => {
    const g = new Graph();
    const session = makeMockSession([makeMockPage()]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      session,
      extractors: [
        { name: "after", run: async () => ({ produced: true, durationMs: 0 }) },
      ] as any,
    });
    await c.crawl();
    expect(g.getDiagnostics().extractorFailures).toHaveLength(0);
  });

  it("writes AxNodes and records no empty-graph diagnostic when the walker returns a real tree", async () => {
    const g = new Graph();
    const tree: WalkResult = {
      root: axNode({
        role: "document",
        children: [
          axNode({ domOrder: 1, tag: "main", role: "main", children: [
            axNode({ domOrder: 2, tag: "button", role: "button", name: "Sign up", focusable: true }),
          ] }),
        ],
      }),
      count: 3,
    };
    const session = makeMockSession([makeMockPage({ axTree: tree })]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();

    // The structural path must be clean: this is the F7 regression guard.
    // The stub deliberately does not shape `script.evaluate` for the other
    // four extractors (see the note on `makeMockPage`), so those failures are
    // expected here and are asserted nowhere — this suite covers BFS/budget/
    // dedup, and each extractor has its own dedicated suite for its contract.
    const structural = g.getDiagnostics().extractorFailures.filter((f) => f.extractor === "structure");
    expect(structural).toHaveLength(0);
    expect(g.axCount).toBe(3);
    expect(g.axByPage("page:https://example.com/")).toHaveLength(3);
    const button = g.axByPage("page:https://example.com/").find((a) => a.role === "button");
    expect(button?.name).toBe("Sign up");
    // The page links back to the tree root (structural extractor contract).
    expect(g.getPage("page:https://example.com/")?.axTreeRef?.rootAxId).toBeTruthy();
  });

  it("records pageError and marks loadStatus='timeout' or 'spa-error' when navigation fails", async () => {
    const g = new Graph();
    const failingPage = makeMockPage();
    failingPage.navigate = vi.fn(async () => {
      throw new Error("Navigation timed out after 30000ms");
    });
    const session = makeMockSession([failingPage]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/dead",
      session,
    });
    await c.crawl();
    const p = g.getPage("page:https://example.com/dead");
    expect(p).toBeDefined();
    expect(p?.loadStatus).toBe("timeout");
    expect(g.getDiagnostics().pageErrors).toHaveLength(1);
    expect(g.getDiagnostics().pageErrors[0]?.url).toBe("https://example.com/dead");
    expect(g.getDiagnostics().pageErrors[0]?.status).toBe("timeout");

  });
});

/**
 * ED-03 / T3: parentPageId + nav:child-of. Pure tests for the static
 * `findParentPageId` helper, then integration tests that drive the
 * orchestrator over a mock session and assert the graph's hierarchy
 * matches the URL-prefix rule.
 */
describe("Crawler.findParentPageId — pure helper (ED-03)", () => {
  function page(id: string, url: string): PageNode {
    return {
      id, type: "page", url, title: url, discoveredVia: [],
      loadStatus: "complete",
      axTreeRef: { rootAxId: "ax:root", provenance: "html:t" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null, screenshotRef: null,
      canonicalUrl: Crawler.canonicalize(url), crawledAt: "t",
      parentPageId: null,
    };
  }

  it("returns null when there are no existing pages", () => {
    expect(Crawler.findParentPageId("https://example.com/a", null, new Map())).toBeNull();
  });

  it("returns null when no page is a prefix", () => {
    const m = new Map<string, PageNode>([
      ["page:https://other.com/", page("page:https://other.com/", "https://other.com/")],
    ]);
    expect(Crawler.findParentPageId("https://example.com/a", null, m)).toBeNull();
  });

  it("picks the longest matching prefix", () => {
    const m = new Map<string, PageNode>([
      ["page:https://example.com/", page("page:https://example.com/", "https://example.com/")],
      ["page:https://example.com/settings", page("page:https://example.com/settings", "https://example.com/settings")],
      ["page:https://example.com/settings/appearance", page("page:https://example.com/settings/appearance", "https://example.com/settings/appearance")],
    ]);
    const parent = Crawler.findParentPageId("https://example.com/settings/appearance/theme", null, m);
    expect(parent).toBe("page:https://example.com/settings/appearance");
  });

  it("treats the root as a prefix for any non-root path", () => {
    const m = new Map<string, PageNode>([
      ["page:https://example.com/", page("page:https://example.com/", "https://example.com/")],
    ]);
    expect(Crawler.findParentPageId("https://example.com/a", null, m))
      .toBe("page:https://example.com/");
  });

  it("rejects non-boundary prefixes: /set is not a prefix of /settings", () => {
    const m = new Map<string, PageNode>([
      ["page:https://example.com/set", page("page:https://example.com/set", "https://example.com/set")],
    ]);
    // The new URL is /settings; /set is a textual prefix but not a
    // boundary prefix. The helper should refuse and return null.
    expect(Crawler.findParentPageId("https://example.com/settings", null, m)).toBeNull();
  });

  it("falls back to the referrer URL when no prefix exists", () => {
    const m = new Map<string, PageNode>([
      ["page:https://example.com/refer", page("page:https://example.com/refer", "https://example.com/refer")],
    ]);
    // The new URL has no prefix in m; the referrer matches "page:https://example.com/refer".
    const parent = Crawler.findParentPageId("https://other.com/x", "https://example.com/refer", m);
    expect(parent).toBe("page:https://example.com/refer");
  });

  it("returns null when neither prefix nor referrer matches", () => {
    const m = new Map<string, PageNode>([
      ["page:https://example.com/", page("page:https://example.com/", "https://example.com/")],
    ]);
    expect(Crawler.findParentPageId("https://other.com/x", "https://other.com/y", m)).toBeNull();
  });

  it("ignores the referrer when a prefix match exists", () => {
    // /settings/appearance has prefix /settings (already in m). Even if the
    // referrer is some unrelated page, the prefix rule wins.
    const m = new Map<string, PageNode>([
      ["page:https://example.com/", page("page:https://example.com/", "https://example.com/")],
      ["page:https://example.com/settings", page("page:https://example.com/settings", "https://example.com/settings")],
      ["page:https://example.com/unrelated", page("page:https://example.com/unrelated", "https://example.com/unrelated")],
    ]);
    expect(Crawler.findParentPageId("https://example.com/settings/appearance", "https://example.com/unrelated", m))
      .toBe("page:https://example.com/settings");
  });
});

describe("Crawler BFS — ED-03 navigation hierarchy", () => {
  function makeMockPage(overrides: Partial<{ url: string; title: string; outLinks: string[]; }> = {}) {
    const outLinks = overrides.outLinks ?? [];
    return {
      url: Promise.resolve(overrides.url ?? "https://example.com/"),
      title: Promise.resolve(overrides.title ?? "T"),
      target: { context: "ctx" } as any,
      navigate: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      script: {
        evaluate: vi.fn(async (_t: any, src: string) => {
          if (src.includes("querySelector('h1")) return "Hello";
          if (src.includes("querySelectorAll('[role]")) return 5;
          if (src.includes("getBoundingClientRect")) return [];
          if (src.includes("popovertarget")) return [];
          if (src.includes("querySelectorAll('a[href]")) return outLinks;
          if (src.includes("querySelectorAll('button, a, [role=button]")) return 0;
          if (src.includes("querySelectorAll('*'))")) return 0;
          return null;
        }),
        callFunction: vi.fn(async (_t: any, _fn: string, _args: any[]) =>
          outLinks.map((href) => ({
            fromAxId: `ax:page:href:${href}`,
            toAxId: `ax:page:href:${href}`,
            kind: "link",
            href,
            rawHref: href,
            isExternal: false,
            isAnchor: false,
            isJs: false,
          })),
        ),
      },
    } as any;
  }
  function makeMockSession(pages: any[]) {
    return {
      newPage: vi.fn(async () => pages.shift() ?? makeMockPage()),
      close: vi.fn(async () => undefined),
    } as any;
  }

  it("single-page crawl: the only page has parentPageId: null", async () => {
    const g = new Graph();
    const session = makeMockSession([makeMockPage()]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    const root = g.getPage("page:https://example.com/")!;
    expect(root.parentPageId).toBeNull();
  });

  it("linear crawl: child page has parentPageId of the root", async () => {
    const g = new Graph();
    const rootPage = makeMockPage({ url: "https://example.com/", outLinks: ["https://example.com/a"] });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: [] });
    const session = makeMockSession([rootPage, pageA]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      budget: { maxPages: 10, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
      session,
    });
    await c.crawl();
    expect(g.getPage("page:https://example.com/")!.parentPageId).toBeNull();
    expect(g.getPage("page:https://example.com/a")!.parentPageId).toBe("page:https://example.com/");
  });

  it("tree crawl: each page's parent is its longest URL-prefix ancestor", async () => {
    const g = new Graph();
    // Root has 3 children: /a, /b, /c. /a has 2 children: /a/x, /a/y.
    const rootPage = makeMockPage({
      url: "https://example.com/",
      outLinks: [
        "https://example.com/a", "https://example.com/b", "https://example.com/c",
      ],
    });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: ["https://example.com/a/x", "https://example.com/a/y"] });
    const pageB = makeMockPage({ url: "https://example.com/b", outLinks: [] });
    const pageC = makeMockPage({ url: "https://example.com/c", outLinks: [] });
    const pageX = makeMockPage({ url: "https://example.com/a/x", outLinks: [] });
    const pageY = makeMockPage({ url: "https://example.com/a/y", outLinks: [] });
    const session = makeMockSession([rootPage, pageA, pageB, pageC, pageX, pageY]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      budget: { maxPages: 10, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
      session,
    });
    await c.crawl();
    // Root has no parent; /a /b /c have root as parent; /a/x /a/y have /a as parent.
    expect(g.getPage("page:https://example.com/")!.parentPageId).toBeNull();
    expect(g.getPage("page:https://example.com/a")!.parentPageId).toBe("page:https://example.com/");
    expect(g.getPage("page:https://example.com/b")!.parentPageId).toBe("page:https://example.com/");
    expect(g.getPage("page:https://example.com/c")!.parentPageId).toBe("page:https://example.com/");
    expect(g.getPage("page:https://example.com/a/x")!.parentPageId).toBe("page:https://example.com/a");
    expect(g.getPage("page:https://example.com/a/y")!.parentPageId).toBe("page:https://example.com/a");
  });

  it("emits one nav:child-of edge per non-root page (parent -> child)", async () => {
    const g = new Graph();
    const rootPage = makeMockPage({
      url: "https://example.com/",
      outLinks: ["https://example.com/a", "https://example.com/b"],
    });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: [] });
    const pageB = makeMockPage({ url: "https://example.com/b", outLinks: [] });
    const session = makeMockSession([rootPage, pageA, pageB]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    // 2 children = 2 nav:child-of edges, plus the original `link` edges
    // emitted by the discovery extractor.
    const navEdges = [...g.edgesFrom("page:https://example.com/", "nav:child-of")];
    expect(navEdges).toHaveLength(2);
    const navEdgeToIds = navEdges.map((e) => e.to).sort();
    expect(navEdgeToIds).toEqual([
      "page:https://example.com/a",
      "page:https://example.com/b",
    ]);
  });

  it("root page has no incoming nav:child-of edge", async () => {
    const g = new Graph();
    const rootPage = makeMockPage({ url: "https://example.com/", outLinks: ["https://example.com/a"] });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: [] });
    const session = makeMockSession([rootPage, pageA]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    const incomingToRoot = g.edgesTo("page:https://example.com/", "nav:child-of");
    expect(incomingToRoot).toEqual([]);
  });

  it("edge provenance is 'html:hierarchy'", async () => {
    const g = new Graph();
    const rootPage = makeMockPage({ url: "https://example.com/", outLinks: ["https://example.com/a"] });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: [] });
    const session = makeMockSession([rootPage, pageA]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    const e = g.edgesFrom("page:https://example.com/", "nav:child-of")[0]!;
    expect(e.provenance).toBe("html:hierarchy");
  });
});

// PR-8a: orchestrator wires NavElements and the nav-link post-pass
// through the crawl. The mock's callFunction returns the records
// the declared extractor materializes (breadcrumbs, tablists,
// state:cause) and the discovery extractor emits page-to-page
// nav-link edges when both ends are in the graph.
describe("Crawler — PR-8a nav-link + NavElement wiring", () => {
  function makeMockPage(overrides: Partial<{ url: string; title: string; outLinks: string[]; }> = {}) {
    const outLinks = overrides.outLinks ?? [];
    const pageId = `page:${overrides.url ?? "https://example.com/"}`;
    return {
      url: Promise.resolve(overrides.url ?? "https://example.com/"),
      title: Promise.resolve(overrides.title ?? "T"),
      target: { context: "ctx" } as any,
      navigate: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      script: {
        evaluate: vi.fn(async (_t: any, src: string) => {
          if (src.includes("querySelector('h1")) return "Hello";
          if (src.includes("querySelectorAll('[role]")) return 5;
          if (src.includes("getBoundingClientRect")) return [];
          if (src.includes("popovertarget")) return [];
          if (src.includes("querySelectorAll('a[href]")) return outLinks;
          if (src.includes("querySelectorAll('button, a, [role=button]")) return 0;
          if (src.includes("querySelectorAll('*'))")) return 0;
          return null;
        }),
        // Real-shape link records: fromAxId is on the source page so
        // the buildNavLinkEdges post-pass can match it. (The non-PR-8a
        // BFS tests don't care about the pageId because the link edge
        // is only ever read by the discovery extractor in those tests.)
        callFunction: vi.fn(async (_t: any, _fn: string, _args: any[]) =>
          outLinks.map((href) => ({
            fromAxId: `ax:${pageId}:href:${href}`,
            toAxId: `ax:${pageId}:href:${href}`,
            kind: "link",
            href,
            rawHref: href,
            isExternal: false,
            isAnchor: false,
            isJs: false,
          })),
        ),
      },
    } as any;
  }
  function makeMockSession(pages: any[]) {
    return {
      newPage: vi.fn(async () => pages.shift() ?? makeMockPage()),
      close: vi.fn(async () => undefined),
    } as any;
  }


  it("post-discovery pass emits one nav-link edge per (source, target) page pair", async () => {
    const g = new Graph();
    const rootPage = makeMockPage({ url: "https://example.com/", outLinks: ["https://example.com/a"] });
    const pageA = makeMockPage({ url: "https://example.com/a", outLinks: [] });
    const session = makeMockSession([rootPage, pageA]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    // nav-link edges are page-to-page, separate from the
    // ax-level "link" edges written by the discovery extractor.
    const navLink = g.edgesFrom("page:https://example.com/", "nav-link");
    expect(navLink).toHaveLength(1);
    expect(navLink[0]?.to).toBe("page:https://example.com/a");
    expect(navLink[0]?.provenance).toBe("html:hierarchy");
  });

  it("breadcrumbs declared by the page-side walker are upserted as NavElements", async () => {
    const g = new Graph();
    const records = [
      { fromAxId: "ax:page:bc-nav", toAxId: null, kind: "nav-element", navKind: "breadcrumb",
        memberAxIds: ["ax:page:bc-0", "ax:page:bc-1"], activeMemberAxId: null },
    ];
    const page = makeMockPage();
    (page.script as any).callFunction = vi.fn(async () => records);
    const session = makeMockSession([page]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    const navs = g.navElementsByPage("page:https://example.com/");
    expect(navs).toHaveLength(1);
    expect(navs[0]?.kind).toBe("breadcrumb");
    expect(navs[0]?.memberAxIds).toEqual(["ax:page:bc-0", "ax:page:bc-1"]);
  });

  it("tablists declared by the page-side walker are upserted with the active member", async () => {
    const g = new Graph();
    const records = [
      { fromAxId: "ax:page:tablist-c", toAxId: null, kind: "nav-element", navKind: "tablist",
        memberAxIds: ["ax:page:t1", "ax:page:t2", "ax:page:t3"], activeMemberAxId: "ax:page:t2" },
    ];
    const page = makeMockPage();
    (page.script as any).callFunction = vi.fn(async () => records);
    const session = makeMockSession([page]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    const tablist = g.navElementsByPage("page:https://example.com/").find((n) => n.kind === "tablist")!;
    expect(tablist).toBeDefined();
    expect(tablist.activeMemberAxId).toBe("ax:page:t2");
  });

  it("state:cause placeholder edges are resolved (or removed) by the declared extractor", async () => {
    const g = new Graph();
    const records = [
      { fromAxId: "ax:page:btn1", kind: "state:cause", toAxId: "state:TBD:ax:page:btn1:commandfor" },
      { fromAxId: "ax:page:tab1", kind: "state:cause", toAxId: "state:TBD:ax:page:tab1:apg-tab-activate" },
    ];
    const page = makeMockPage();
    (page.script as any).callFunction = vi.fn(async () => records);
    const session = makeMockSession([page]);
    const c = new Crawler(g, { rootUrl: "https://example.com/", session });
    await c.crawl();
    // PR-8b (item 4): the declared extractor resolves
    // `state:TBD:*` placeholders. With no State materialization
    // matching these axIds (the test graph is empty), the
    // placeholders are *removed* — they don't point at a random
    // state. Verify that no `state:cause` edge in the graph has a
    // `state:TBD:` to.
    for (const e of g.allEdges()) {
      if (e.kind === "state:cause") {
        expect(e.to.startsWith("state:TBD:")).toBe(false);
      }
    }
  });
});

// PR-8c T5: real auth sessions applied; URL×auth graphs differ.
// The orchestrator iterates `URL × auth-context` pairs and applies
// each spec to a real BiDi Page (storage.setCookies / localStorage).
// A different auth context must produce a different observed
// state graph (because the page renders differently under each
// context). This test uses a mock page whose observed content
// varies with the cookies that `applyAuthSpec` sets.
describe("Crawler — PR-8c T5: URL × auth matrix produces different state graphs", () => {
  function buildRichSnapshot(authKind: string, principal: string | null, dialogs: string[], axCount: number) {
    // Build a realistic RichSnapshot whose hash depends on the auth
    // context and dialog list, so different contexts produce
    // different canonical state ids.
    const elements = Array.from({ length: axCount }, (_, i) => ({
      axId: `ax:page:el${i}`,
      rect: { x: 0, y: 0, w: 100, h: 30 },
      visibility: "visible",
      zIndex: null,
      open: null,
      expanded: null,
      selected: null,
      checked: null,
      pressed: null,
      busy: null,
      // PR-8g T1: per-element focus flag.
      focused: false,
      ariaStates: {},
      visualNodeId: `vis:page:el${i}`,
      conditionalMarkers: {},
    }));
    const raw = JSON.stringify({ elements, openDialogIds: dialogs, authKind, principal });
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return {
      hash: "h:" + h.toString(16),
      elements,
      openDialogIds: dialogs,
      openPopoverIds: [],
      expandedRegionAxIds: [],
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      online: true,
      conditionalMarkers: {},
      // PR-8g T1: State-level focus pointer. The auth-context-
      // aware test does not exercise focus changes; default to
      // null.
      focusedAxId: null,
    };
  }

  function makeAuthAwarePage(opts: {
    url: string;
    /** Observed a11y count for the anonymous context. */
    a11yCountAnon: number;
    /** Observed a11y count for the authenticated context. */
    a11yCountAuth: number;
    /** Dialogs visible to anonymous (e.g. "Sign in to continue" modal). */
    dialogsAnon: string[];
    /** Dialogs visible to authenticated. */
    dialogsAuth: string[];
  }) {
    // The mock's `storage.setCookies` updates the page's auth kind
    // when `applyAuthSpec` is called. Subsequent `callFunction`
    // (used by the observed extractor's `takeRichSnapshot`) reads
    // the closure to choose which snapshot to return.
    let activeAuthKind: "anonymous" | "authenticated" | "administrator" | "custom-role" = "anonymous";
    let activePrincipal: string | null = null;
    const page = {
      url: Promise.resolve(opts.url),
      title: Promise.resolve("T"),
      target: { context: "ctx" } as any,
      navigate: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      script: {
        evaluate: vi.fn(async (_t: any, src: string) => {
          if (src.includes("querySelector('h1")) return "Hello";
          if (src.includes("querySelectorAll('[role]")) return 5;
          if (src.includes("getBoundingClientRect")) return [];
          if (src.includes("popovertarget")) return [];
          if (src.includes("querySelectorAll('a[href]")) return [];
          if (src.includes("querySelectorAll('button, a, [role=button]")) return 0;
          if (src.includes("querySelectorAll('*'))")) return 0;
          return null;
        }),
        callFunction: vi.fn(async (_t: any, fn: string, _args: any[]) => {
          // The structural/visual/declared extractors use
          // `callFunction` to walk the DOM. The observed extractor's
          // snapshot is also a `callFunction` — but its body is
          // unique (it returns `{ hash, elements, ... }` instead of
          // an array). Distinguish them by checking whether the
          // function body contains the snapshot shape markers.
          if (fn.includes("__awgTakeRichSnapshot") || (fn.includes("openDialogIds") && fn.includes("viewport"))) {
            const dialogs = activeAuthKind === "anonymous" ? opts.dialogsAnon : opts.dialogsAuth;
            const axCount = activeAuthKind === "anonymous" ? opts.a11yCountAnon : opts.a11yCountAuth;
            return buildRichSnapshot(activeAuthKind, activePrincipal, dialogs, axCount);
          }
          // Otherwise: structural/visual/declared/discovery walker.
          // Return a single no-op link record so the discovery
          // extractor (which writes `link` edges) has something
          // to process.
          return [{
            fromAxId: `ax:${opts.url.replace(/[:/]+/g, "_")}:href:about:blank`,
            toAxId: `ax:${opts.url.replace(/[:/]+/g, "_")}:href:about:blank`,
            kind: "link",
            href: "about:blank",
            rawHref: "about:blank",
            isExternal: false,
            isAnchor: false,
            isJs: false,
          }];
        }),
      },
      storage: {
        setCookies: vi.fn(async (_origin: string, cookies: any[]) => {
          for (const c of cookies) {
            if (c.name === "session") {
              activeAuthKind = "authenticated";
              activePrincipal = "alice";
            } else if (c.name === "role" && c.value === "admin") {
              activeAuthKind = "administrator";
              activePrincipal = "bob";
            }
          }
          return cookies.length;
        }),
        getCookies: vi.fn(async () => ({ cookies: [], partitionKey: {} })),
      },
    } as any;
    return page;
  }
  function makeMockSession(pages: any[]) {
    return {
      newPage: vi.fn(async () => pages.shift() ?? pages[pages.length - 1]),
      close: vi.fn(async () => undefined),
    } as any;
  }

  /**
   * PR-8j J6 (test seam): the production orchestrator creates a
   * SEPARATE `BiDiSession` for `runCausalAuthFlow` (BiDi
   * `storage.setCookies` writes to the user-level cookie jar of
   * the WebDriver session, so a fresh session is required for the
   * same-page causal guarantee). Tests inject a factory here so
   * the orchestrator does not call the real `BiDiSession.create()`
   * behind the test's back. The factory returns a no-op mock
   * session: its `newPage()` returns a minimal `Page` that the
   * auth flow can navigate / reload against without crashing. The
   * test asserts cookies were set on the matrix session's page,
   * not the auth flow's outcome.
   */
  function makeNoopAuthFlowSessionFactory() {
    const noopPage = {
      url: Promise.resolve("https://example.com/"),
      title: Promise.resolve("T"),
      target: { context: "auth-ctx" } as any,
      navigate: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      script: {
        evaluate: vi.fn(async () => null),
        callFunction: vi.fn(async () => ({ hash: "h:noop", elements: [], openDialogIds: [], openPopoverIds: [], expandedRegionAxIds: [], viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 }, online: true, conditionalMarkers: {}, focusedAxId: null })),
      },
      storage: {
        setCookies: vi.fn(async () => 0),
        getCookies: vi.fn(async () => ({ cookies: [], partitionKey: {} })),
      },
      input: { performActions: vi.fn(async () => undefined) },
    } as any;
    return async () => ({
      newPage: vi.fn(async () => noopPage),
      close: vi.fn(async () => undefined),
    } as any);
  }

  it("applyAuthSpec configures cookies for the session before extraction", async () => {
    const g = new Graph();
    const page = makeAuthAwarePage({
      url: "https://example.com/",
      a11yCountAnon: 4,
      a11yCountAuth: 8,
      dialogsAnon: ["signin-modal"],
      dialogsAuth: [],
    });
    const session = makeMockSession([page]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      auths: [{ kind: "authenticated", principal: "alice", session: "s-1" }],
      session,
      authFlowSessionFactory: makeNoopAuthFlowSessionFactory(),
    });
    await c.crawl();
    // The orchestrator must have called setCookies with the session
    // cookie for alice's principal.
    expect((page.storage.setCookies as any).mock.calls.length).toBeGreaterThanOrEqual(1);
    const cookiesArg = (page.storage.setCookies as any).mock.calls[0]?.[1] ?? [];
    const names = cookiesArg.map((c: any) => c.name);
    expect(names).toContain("session");
  });

  it("two auth contexts produce different state graphs (different state counts and ids)", async () => {
    const g = new Graph();
    // Two pages are pre-allocated; the second is reused if the
    // orchestrator asks for more.
    const anonPage = makeAuthAwarePage({
      url: "https://example.com/",
      a11yCountAnon: 4,
      a11yCountAuth: 8,
      dialogsAnon: ["signin-modal"],
      dialogsAuth: [],
    });
    const authPage = makeAuthAwarePage({
      url: "https://example.com/",
      a11yCountAnon: 4,
      a11yCountAuth: 8,
      dialogsAnon: ["signin-modal"],
      dialogsAuth: [],
    });
    const session = makeMockSession([anonPage, authPage]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      auths: [
        { kind: "anonymous" },
        { kind: "authenticated", principal: "alice", session: "s-1" },
      ],
      session,
      authFlowSessionFactory: makeNoopAuthFlowSessionFactory(),
    });
    await c.crawl();
    // Both auth contexts ran extractors. The state graph should
    // contain at least one State node; the auth-specific states
    // differ because their payloads include the auth context.
    const states = [...g.states()];
    expect(states.length).toBeGreaterThan(0);
    // At least one state was observed under each auth context.
    const authKinds = new Set(states.map((s) => s.authContext.kind));
    expect(authKinds.has("anonymous")).toBe(true);
    expect(authKinds.has("authenticated")).toBe(true);
  });

  it("a single page's state graph under one auth context does not bleed into another", async () => {
    const g = new Graph();
    // Same URL crawled under two contexts — a page that records its
    // current auth context in the snapshot. The graphs must
    // differ: states from anon and from authenticated are separate
    // nodes, not collapsed by the canonical id (which includes the
    // auth context).
    const anonPage = makeAuthAwarePage({
      url: "https://example.com/",
      a11yCountAnon: 3,
      a11yCountAuth: 7,
      dialogsAnon: [],
      dialogsAuth: ["welcome-banner"],
    });
    const authPage = makeAuthAwarePage({
      url: "https://example.com/",
      a11yCountAnon: 3,
      a11yCountAuth: 7,
      dialogsAnon: [],
      dialogsAuth: ["welcome-banner"],
    });
    const session = makeMockSession([anonPage, authPage]);
    const c = new Crawler(g, {
      rootUrl: "https://example.com/",
      auths: [
        { kind: "anonymous" },
        { kind: "authenticated", principal: "alice", session: "s-1" },
      ],
      session,
      authFlowSessionFactory: makeNoopAuthFlowSessionFactory(),
    });
    await c.crawl();
    // Group states by their auth context's `kind`; both groups
    // must exist and the ids must be disjoint (the canonical
    // payload includes the auth context).
    const anonIds = new Set<string>();
    const authIds = new Set<string>();
    for (const s of g.states()) {
      if (s.authContext.kind === "anonymous") anonIds.add(s.id);
      else if (s.authContext.kind === "authenticated") authIds.add(s.id);
    }
    expect(anonIds.size).toBeGreaterThan(0);
    expect(authIds.size).toBeGreaterThan(0);
    // The disjoint property: no state id appears under both
    // contexts (the canonical payload separates them).
    for (const id of anonIds) expect(authIds.has(id)).toBe(false);
  });
});
