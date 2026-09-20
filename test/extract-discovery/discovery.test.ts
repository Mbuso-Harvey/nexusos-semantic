/**
 * Unit tests for the Stage 9 discovery (link walker) extractor.
 *
 * We mock `Page.script.callFunction` to return a synthetic link list
 * spanning same-origin, anchor, external, and javascript: variants, then
 * verify the edges and the same-origin URL payload the extractor hands
 * back to the orchestrator.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DiscoveryExtractor,
  classifyLink,
  buildEdge,
} from "../../src/extract-discovery/discovery.js";
import { buildNavLinkEdges, canonicalizeUrl } from "../../src/extract-discovery/nav-links.js";
import { Graph } from "../../src/graph/graph.js";
import type { Page } from "../../src/bidi-client/page.js";
import type { PageNode } from "../../src/graph/types.js";
import type { DiscoveryLinkRecord } from "../../src/extract-discovery/discovery.js";

const PAGE_ID = "page:https://example.com/";

function makePage(): PageNode {
  return {
    id: PAGE_ID,
    type: "page",
    url: "https://example.com/",
    title: "T",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: "https://example.com/",
    crawledAt: new Date(0).toISOString(), parentPageId: null,
  };
}

function sameOrigin(href: string, rawHref: string = href): DiscoveryLinkRecord {
  return {
    fromAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    toAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    kind: "link",
    href,
    rawHref,
    isExternal: false,
    isAnchor: false,
    isJs: false,
  };
}

function anchorLink(rawHref: string): DiscoveryLinkRecord {
  return {
    fromAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    toAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    kind: "link",
    href: rawHref,
    rawHref,
    isExternal: false,
    isAnchor: true,
    isJs: false,
  };
}

function externalLink(href: string, rawHref: string = href): DiscoveryLinkRecord {
  return {
    fromAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    toAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    kind: "link",
    href,
    rawHref,
    isExternal: true,
    isAnchor: false,
    isJs: false,
  };
}

function jsLink(rawHref: string): DiscoveryLinkRecord {
  return {
    fromAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    toAxId: `ax:${PAGE_ID}:href:${rawHref}`,
    kind: "link",
    href: "",
    rawHref,
    isExternal: false,
    isAnchor: false,
    isJs: true,
  };
}

function makeMockPage(records: DiscoveryLinkRecord[]) {
  const callFunction = vi.fn(async () => records);
  const page = {
    target: { context: "ctx" } as any,
    script: { callFunction },
  } as unknown as Page;
  return { page, callFunction };
}

describe("classifyLink", () => {
  it("returns 'javascript' for js: links", () => {
    expect(classifyLink(jsLink("javascript:void(0)"))).toBe("javascript");
  });
  it("returns 'anchor' for # links", () => {
    expect(classifyLink(anchorLink("#section"))).toBe("anchor");
  });
  it("returns 'external' for cross-origin links", () => {
    expect(classifyLink(externalLink("https://other.com/x"))).toBe("external");
  });
  it("returns 'same-origin' for matching-origin links", () => {
    expect(classifyLink(sameOrigin("https://example.com/a"))).toBe("same-origin");
  });
  it("returns 'unparseable' for empty href", () => {
    expect(classifyLink(sameOrigin(""))).toBe("unparseable");
  });
});

describe("buildEdge — provenance + target axId", () => {
  const page = makePage();

  it("emits 'html:href' for same-origin links", () => {
    const e = buildEdge(page, sameOrigin("https://example.com/a", "/a"), "same-origin");
    expect(e).not.toBeNull();
    expect(e!.kind).toBe("link");
    expect(e!.provenance).toBe("html:href");
  });

  it("emits 'html:anchor' for # links", () => {
    const e = buildEdge(page, anchorLink("#section"), "anchor");
    expect(e).not.toBeNull();
    expect(e!.provenance).toBe("html:anchor");
  });

  it("marks external destinations in the axId", () => {
    const e = buildEdge(page, externalLink("https://other.com/x", "/x"), "external");
    expect(e).not.toBeNull();
    expect(e!.to).toBe(`ax:${PAGE_ID}:external:/x`);
    expect(e!.provenance).toBe("html:href");
  });

  it("marks javascript: destinations in the axId", () => {
    const e = buildEdge(page, jsLink("javascript:void(0)"), "javascript");
    expect(e).not.toBeNull();
    expect(e!.to).toBe(`ax:${PAGE_ID}:js:javascript:void(0)`);
    expect(e!.provenance).toBe("html:href");
  });
});

describe("DiscoveryExtractor.process", () => {
  let extractor: DiscoveryExtractor;
  beforeEach(() => { extractor = new DiscoveryExtractor(); });

  it("writes link edges with provenance 'html:href' for same-origin links", () => {
    const records = [sameOrigin("https://example.com/a", "/a")];
    const { edges } = extractor.process(makePage(), records);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe("link");
    expect(edges[0]!.provenance).toBe("html:href");
  });

  it("writes link edges with provenance 'html:anchor' for same-page anchors", () => {
    const records = [anchorLink("#section")];
    const { edges } = extractor.process(makePage(), records);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.provenance).toBe("html:anchor");
  });

  it("marks external links but does not enqueue them in sameOriginUrls", () => {
    const records = [externalLink("https://other.com/x", "/x")];
    const { edges, sameOriginUrls } = extractor.process(makePage(), records);
    expect(edges).toHaveLength(1);
    expect(sameOriginUrls).toEqual([]);
  });

  it("does not enqueue javascript: URLs", () => {
    const records = [jsLink("javascript:void(0)")];
    const { edges, sameOriginUrls } = extractor.process(makePage(), records);
    expect(edges).toHaveLength(1);
    expect(sameOriginUrls).toEqual([]);
  });

  it("returns same-origin URLs as the orchestrator-consumable payload", () => {
    const records = [
      sameOrigin("https://example.com/projects", "/projects"),
      sameOrigin("https://example.com/about", "/about"),
      externalLink("https://other.com/x"),
      anchorLink("#top"),
      jsLink("javascript:void(0)"),
    ];
    const { sameOriginUrls } = extractor.process(makePage(), records);
    expect(sameOriginUrls).toEqual([
      "https://example.com/projects",
      "https://example.com/about",
    ]);
  });

  it("resolves the link axId for <a id='foo'> to ax:<pageId>:foo", () => {
    // The page-side walker assigns fromAxId from element.id; the Node side
    // should preserve that axId in the edge it writes.
    const r: DiscoveryLinkRecord = {
      fromAxId: `ax:${PAGE_ID}:foo`,
      toAxId: `ax:${PAGE_ID}:href:/projects`,
      kind: "link",
      href: "https://example.com/projects",
      rawHref: "/projects",
      isExternal: false,
      isAnchor: false,
      isJs: false,
    };
    const { edges } = extractor.process(makePage(), [r]);
    expect(edges[0]!.from).toBe(`ax:${PAGE_ID}:foo`);
  });

  it("resolves the link axId for an un-id'd <a> to ax:<pageId>:href:<href>", () => {
    const r: DiscoveryLinkRecord = {
      fromAxId: `ax:${PAGE_ID}:href:/projects`,
      toAxId: `ax:${PAGE_ID}:href:/projects`,
      kind: "link",
      href: "https://example.com/projects",
      rawHref: "/projects",
      isExternal: false,
      isAnchor: false,
      isJs: false,
    };
    const { edges } = extractor.process(makePage(), [r]);
    expect(edges[0]!.from).toBe(`ax:${PAGE_ID}:href:/projects`);
  });
});

describe("DiscoveryExtractor.run — full extractor integration", () => {
  let g: Graph;
  let extractor: DiscoveryExtractor;
  beforeEach(() => { g = new Graph(); extractor = new DiscoveryExtractor(); });

  it("calls page.script.callFunction once and writes the edges into the graph", async () => {
    const records = [
      sameOrigin("https://example.com/a", "/a"),
      anchorLink("#top"),
      externalLink("https://other.com/x"),
      jsLink("javascript:void(0)"),
    ];
    const { page, callFunction } = makeMockPage(records);
    const pageNode = makePage();
    const log = vi.fn();
    const result = await extractor.run({ graph: g, page, pageNode, budget: {} as any, log });

    expect(callFunction).toHaveBeenCalledTimes(1);
    expect(g.edgeCount).toBe(4);
    // same-origin links go to the enqueue list
    expect(result.sameOriginUrls).toEqual(["https://example.com/a"]);
    // log line is a one-line summary
    expect(log).toHaveBeenCalledWith("  [discovery] outbound-links=4 same-origin=1");
  });

  it("returns produced=true when at least one edge is written", async () => {
    const records = [sameOrigin("https://example.com/a", "/a")];
    const { page } = makeMockPage(records);
    const pageNode = makePage();
    const log = vi.fn();
    const r = await extractor.run({ graph: g, page, pageNode, budget: {} as any, log });
    expect(r.produced).toBe(true);
  });

  it("returns produced=false when there are no links", async () => {
    const { page } = makeMockPage([]);
    const pageNode = makePage();
    const log = vi.fn();
    const r = await extractor.run({ graph: g, page, pageNode, budget: {} as any, log });
    expect(r.produced).toBe(false);
    expect(r.sameOriginUrls).toEqual([]);
  });

  it("idempotent: re-running overwrites edges in place (graph dedups by id)", async () => {
    const records = [sameOrigin("https://example.com/a", "/a")];
    const { page } = makeMockPage(records);
    const pageNode = makePage();
    const log = vi.fn();
    await extractor.run({ graph: g, page, pageNode, budget: {} as any, log });
    await extractor.run({ graph: g, page, pageNode, budget: {} as any, log });
    expect(g.edgeCount).toBe(1);
  });
});

// PR-8a T2: resolved page-to-page nav-link edges. The discovery
// extractor writes ax-level "link" edges; the post-discovery pass
// resolves them to one "nav-link" edge per (source page, target
// page) pair. This is the L1 navigation graph that the agent
// surfaces via graph.path with relation=nav-links.
describe("buildNavLinkEdges — PR-8a T2 (resolved page-to-page nav-links)", () => {
  function seedTwoPageGraph(graph: Graph) {
    // Page A is the source; Page B is the target. Both are already in
    // the graph (the orchestrator runs this after discovery has
    // crawled both pages).
    graph.upsertPage(makePage());
    graph.upsertPage({
      ...makePage(),
      id: "page:https://example.com/b",
      url: "https://example.com/b",
      canonicalUrl: "https://example.com/b",
    });
    // A link ax on page A pointing to /b.
    const axId = `ax:${PAGE_ID}:href:/b`;
    graph.upsertAx({
      id: axId, type: "ax-node", pageId: PAGE_ID, role: "link", name: "B",
      nameSource: "aria-label",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null,
      provenance: "bidi:script.evaluate",
    });
    graph.upsertEdge({
      id: `edge:${axId}->${axId}:link`, type: "edge",
      from: axId, to: axId, kind: "link", provenance: "html:href",
    });
    return axId;
  }

  it("emits one nav-link edge per (source page, target page) pair", () => {
    const graph = new Graph();
    seedTwoPageGraph(graph);
    const edges = buildNavLinkEdges(graph, PAGE_ID);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("nav-link");
    expect(edges[0]?.from).toBe(PAGE_ID);
    expect(edges[0]?.to).toBe("page:https://example.com/b");
  });

  it("the edge id is deterministic and follows edge:<fromPageId>-><toPageId>:nav-link", () => {
    const graph = new Graph();
    seedTwoPageGraph(graph);
    const a = buildNavLinkEdges(graph, PAGE_ID);
    const b = buildNavLinkEdges(graph, PAGE_ID);
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[0]?.id).toBe(`edge:${PAGE_ID}->page:https://example.com/b:nav-link`);
  });

  it("external and anchor links do not produce nav-link edges", () => {
    const graph = new Graph();
    graph.upsertPage(makePage());
    const axId = `ax:${PAGE_ID}:href:/local`;
    graph.upsertAx({
      id: axId, type: "ax-node", pageId: PAGE_ID, role: "link", name: "L",
      nameSource: "aria-label",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null,
      provenance: "bidi:script.evaluate",
    });
    // Anchor: no corresponding page.
    graph.upsertEdge({
      id: `edge:${axId}->ax:${PAGE_ID}:href:#section:link`, type: "edge",
      from: axId, to: `ax:${PAGE_ID}:href:#section`, kind: "link", provenance: "html:anchor",
    });
    // External: classification is in the toAxId, buildEdge encodes it.
    graph.upsertEdge({
      id: `edge:${axId}->ax:${PAGE_ID}:external:https://other/:link`, type: "edge",
      from: axId, to: `ax:${PAGE_ID}:external:https://other/`, kind: "link", provenance: "html:href",
    });
    expect(buildNavLinkEdges(graph, PAGE_ID)).toEqual([]);
  });

  it("returns [] when the source page has no link edges", () => {
    const graph = new Graph();
    graph.upsertPage(makePage());
    expect(buildNavLinkEdges(graph, PAGE_ID)).toEqual([]);
  });

  it("canonicalizeUrl drops the fragment and trailing slash, sorts query params", () => {
    expect(canonicalizeUrl("https://example.com/b#x")).toBe("https://example.com/b");
    expect(canonicalizeUrl("https://example.com/b/?b=2&a=1")).toBe("https://example.com/b?a=1&b=2");
    expect(canonicalizeUrl("https://example.com/b/")).toBe("https://example.com/b");
  });
});
