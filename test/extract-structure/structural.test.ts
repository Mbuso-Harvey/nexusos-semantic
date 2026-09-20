/**
 * Stage 5 — extract-structure tests.
 *
 * We exercise the in-page JS walker against a hand-built DOM facade evaluated
 * with Node's `vm` module. This keeps the walker logic identical between
 * tests and production (we re-evaluate the same `WALKER_FN` string the
 * extractor sends to the browser) while avoiding a jsdom dependency.
 *
 * The mock `Page.script.callFunction` reuses the vm-evaluated walker, so the
 * test verifies the actual JS that runs in the browser. The mock `Page`
 * itself just forwards `callFunction` to the vm sandbox.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as vm from "node:vm";
import { Graph } from "../../src/graph/graph.js";
import type { Page } from "../../src/bidi-client/page.js";
import type { PageNode } from "../../src/graph/types.js";
import {
  structuralExtractor,
  WALKER_FN,
  EXTRACT_EDGES_FN,
  type AxTreeNode,
  type WalkResult,
} from "../../src/extract-structure/structural.js";

// ----- Minimal DOM facade -------------------------------------------------
// jsdom isn't a dep. We hand-roll a DOM that supports exactly what the
// walker needs: elements with attributes, childNodes, getElementById, a
// TreeWalker that visits in document order, NodeFilter with SHOW_ELEMENT,
// getAttribute/hasAttribute, .tagName/.id, and a small set of properties.

const NodeFilter_SHOW_ELEMENT = 0x1;

interface MiniEl {
  tagName: string;
  id: string;
  attrs: Map<string, string>;
  childNodes: Array<{ nodeType: number; nodeValue?: string; el?: MiniEl }>;
  parentElement: MiniEl | null;
  open?: boolean;
  disabled?: boolean;
  // DOM API surface used by the walker
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  getElementById(id: string): MiniEl | null;
  querySelectorAll(sel: string): MiniEl[];
}

function makeEl(tag: string, opts: { id?: string; attrs?: Record<string, string>; open?: boolean; disabled?: boolean } = {}): MiniEl {
  const attrs = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.attrs ?? {})) attrs.set(k, v);
  const el: MiniEl = {
    tagName: tag.toUpperCase(),
    id: opts.id ?? "",
    attrs,
    childNodes: [],
    parentElement: null,
    open: opts.open,
    disabled: opts.disabled,
    hasAttribute(name: string) { return attrs.has(name); },
    getAttribute(name: string) { return attrs.has(name) ? attrs.get(name)! : null; },
    // Real Element.getElementById searches the document, not just descendants.
    // We dispatch through a global registry that the sandbox wires up.
    getElementById(id: string) { return (globalThis as any).__findById?.(id) ?? null; },
    querySelectorAll(sel: string) { return (globalThis as any).__queryAll?.(sel) ?? []; },
  };
  return el;
}

function append(parent: MiniEl, child: MiniEl | string) {
  if (typeof child === "string") {
    parent.childNodes.push({ nodeType: 3, nodeValue: child });
  } else {
    child.parentElement = parent;
    parent.childNodes.push({ nodeType: 1, el: child });
  }
}

function findById(root: MiniEl, id: string): MiniEl | null {
  if (root.id === id) return root;
  for (const c of root.childNodes) {
    if (c.nodeType === 1 && c.el) {
      const r = findById(c.el, id);
      if (r) return r;
    }
  }
  return null;
}

function queryAll(root: MiniEl, sel: string): MiniEl[] {
  // Minimal: supports "[attr]" and "tag". Used only by the second-pass
  // walker that looks up `[id]`.
  const out: MiniEl[] = [];
  const visit = (e: MiniEl) => {
    let match = false;
    if (sel.startsWith("[")) {
      const attr = sel.slice(1, -1);
      // `[id]` should match elements with a non-empty DOM id, not just
      // those that explicitly set the attribute (the mock stores the id
      // at `e.id`, not in `e.attrs`).
      if (attr === "id") {
        match = !!e.id;
      } else {
        match = e.attrs.has(attr);
      }
    } else {
      match = e.tagName === sel.toUpperCase();
    }
    if (match) out.push(e);
    for (const c of e.childNodes) if (c.nodeType === 1 && c.el) visit(c.el);
  };
  visit(root);
  return out;
}

// TreeWalker equivalent: pre-order depth-first walk of elements.
// Note: real DOM TreeWalker does NOT yield the root — the walker starts
// iteration at the root's first child. The production walker compensates
// by prepending the root to orderList; the mock matches that contract.
let _walkerStack: MiniEl[] = [];
let _walkerStarted = false;
function makeTreeWalker(root: MiniEl) {
  return {
    nextNode(): MiniEl | null {
      if (!_walkerStarted) {
        _walkerStack = [];
        for (const c of root.childNodes) {
          if (c.nodeType === 1 && c.el) _walkerStack.push(c.el);
        }
        _walkerStarted = true;
      }
      if (_walkerStack.length === 0) return null;
      const e = _walkerStack.shift()!;
      for (const c of e.childNodes) {
        if (c.nodeType === 1 && c.el) _walkerStack.push(c.el);
      }
      return e;
    },
  };
}
function resetWalker() { _walkerStarted = false; _walkerStack = []; }

// Build a sandbox object exposing the DOM and the console.
function makeSandbox(root: MiniEl) {
  return {
    document: {
      documentElement: root,
      getElementById: (id: string) => findById(root, id),
      querySelectorAll: (sel: string) => queryAll(root, sel),
      createTreeWalker(_root: MiniEl, _whatToShow: number, _filter: unknown) {
        resetWalker();
        return makeTreeWalker(root);
      },
    },
    // Document-level registry that Element.getElementById delegates to.
    __findById: (id: string) => findById(root, id),
    __queryAll: (sel: string) => queryAll(root, sel),
    NodeFilter: { SHOW_ELEMENT: NodeFilter_SHOW_ELEMENT },
    console,
  };
}

function runWalker(root: MiniEl, fnSrc: string): WalkResult {
  const sandbox = makeSandbox(root);
  const context = vm.createContext(sandbox);
  // The walker is a bare arrow expression `(_arg) => { ... }`. We wrap it in
  // parens so the vm context parses it as a parenthesized expression, then
  // invoke it with undefined to mirror how BiDi callFunction would.
  const src = `(${fnSrc})(undefined)`;
  const r = vm.runInContext(src, context, { timeout: 1000 });
  return r as WalkResult;
}

function runEdgesExtractor(root: MiniEl, fnSrc: string): Array<{ fromId: string; toId: string; kind: string }> {
  const sandbox = makeSandbox(root);
  const context = vm.createContext(sandbox);
  // EXTRACT_EDGES_FN is a bare arrow function expression `(_arg) => { ... }`.
  // We wrap in parens to keep the vm happy, then invoke with undefined.
  const src = `(${fnSrc})(undefined)`;
  return vm.runInContext(src, context, { timeout: 1000 }) as any;
}

// Flatten an AxTreeNode tree into a pre-order list.
function flat(n: AxTreeNode): AxTreeNode[] {
  const out: AxTreeNode[] = [n];
  for (const c of n.children) out.push(...flat(c));
  return out;
}

// ----- Mock Page ----------------------------------------------------------

interface MockPage extends Pick<Page, "script" | "target"> {}

function makeMockPage(root: MiniEl): MockPage {
  return {
    target: { context: "ctx-1" } as any,
    script: {
      callFunction: async <T = unknown>(_t: any, fn: string, args: unknown[] = []): Promise<T> => {
        if (fn.includes("aria-owns") || fn.includes("aria-flowsto") || fn.includes("commandfor") || fn.includes("popovertarget")) {
          return runEdgesExtractor(root, fn) as unknown as T;
        }
        return runWalker(root, fn) as unknown as T;
      },
      evaluate: async <T = unknown>(_t: any, _expr: string): Promise<T> => undefined as unknown as T,
    } as any,
  };
}

function makePageNode(url = "https://example.com/"): PageNode {
  return {
    id: `page:${url}`,
    type: "page",
    url,
    title: "Test",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:placeholder", provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: url,
    crawledAt: "2025-01-01T00:00:00Z", parentPageId: null,
  };
}

// ----- Tests ---------------------------------------------------------------

describe("extract-structure / walker", () => {
  it("emits the right role for common HTML elements", () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const nav = makeEl("nav"); append(body, nav);
    const main = makeEl("main"); append(body, main);
    const h1 = makeEl("h1"); append(main, h1); append(h1, "Title");
    const a = makeEl("a", { attrs: { href: "/x" } }); append(main, a); append(a, "Go");
    const btn = makeEl("button"); append(main, btn); append(btn, "Submit");
    const inp = makeEl("input", { attrs: { type: "text" } }); append(main, inp);
    const inp2 = makeEl("input", { attrs: { type: "checkbox" } }); append(main, inp2);
    const inp3 = makeEl("input", { attrs: { type: "search" } }); append(main, inp3);
    const sect = makeEl("section", { attrs: { "aria-label": "Docs" } }); append(main, sect);

    const r = runWalker(root, WALKER_FN);
    expect(r.count).toBeGreaterThan(0);
    const all = flat(r.root!).map((n) => n);
    const find = (tag: string) => all.find((n) => n.tag === tag)!;
    expect(find("nav").role).toBe("navigation");
    expect(find("main").role).toBe("main");
    expect(find("h1").role).toBe("heading");
    expect(find("a").role).toBe("link");
    expect(find("button").role).toBe("button");
    expect(find("section").role).toBe("region");
    // The first <input> with type=text becomes a textbox; we have multiple.
    const inputs = all.filter((n) => n.tag === "input");
    expect(inputs.some((n) => n.role === "textbox")).toBe(true);
    expect(inputs.some((n) => n.role === "checkbox")).toBe(true);
    expect(inputs.some((n) => n.role === "searchbox")).toBe(true);
  });

  it("resolves the accessible name in spec order: aria-label > aria-labelledby > alt > placeholder > title > textContent", () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    // 1. aria-label wins over everything
    const aria = makeEl("button", { attrs: { "aria-label": "From aria", title: "From title" } });
    append(aria, "From text");
    append(body, aria);
    // 2. aria-labelledby
    const labelTarget = makeEl("span", { id: "lbl" }); append(labelTarget, "Labelled");
    const labelled = makeEl("button", { attrs: { "aria-labelledby": "lbl", title: "From title" } });
    append(labelled, "From text");
    append(body, labelTarget);
    append(body, labelled);
    // 3. alt for img
    const img = makeEl("img", { attrs: { alt: "Alt text" } });
    append(body, img);
    // 4. placeholder for input
    const ph = makeEl("input", { attrs: { type: "text", placeholder: "Type here", title: "From title" } });
    append(body, ph);
    // 5. title fallback
    const titled = makeEl("button", { attrs: { title: "From title" } });
    append(body, titled);
    // 6. textContent fallback
    const noMeta = makeEl("button");
    append(noMeta, "Just text");
    append(body, noMeta);

    const r = runWalker(root, WALKER_FN);
    const all = flat(r.root!);
    const elInfo = all.map(n => `${n.tag}:${JSON.stringify(n.name)}/${n.nameSource}`).join(" | ");
    console.log("DEBUG all elements:", elInfo);
    expect(all.find((n) => n.name === "From aria")!.nameSource).toBe("aria-label");
    expect(all.find((n) => n.tag === "button" && n.name === "Labelled")!.nameSource).toBe("aria-labelledby");
    expect(all.find((n) => n.tag === "img")!.name).toBe("Alt text");
    expect(all.find((n) => n.tag === "img")!.nameSource).toBe("alt");
    expect(all.find((n) => n.tag === "input")!.name).toBe("Type here");
    expect(all.find((n) => n.tag === "input")!.nameSource).toBe("placeholder");
    expect(all.find((n) => n.name === "From title")!.nameSource).toBe("title");
    expect(all.find((n) => n.name === "Just text")!.nameSource).toBe("content");
  });

  it("captures aria-controls refs as properties", () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const panel = makeEl("div", { id: "panel" });
    const trigger = makeEl("button", {
      id: "trigger",
      attrs: { "aria-controls": "panel", "aria-expanded": "true" },
    });
    append(body, trigger);
    append(body, panel);

    const r = runWalker(root, WALKER_FN);
    const all = flat(r.root!);
    const trig = all.find((n) => n.tag === "button")!;
    expect(trig.properties.controls).toEqual(["panel"]);
    expect(trig.states.expanded).toBe(true);
    expect(trig.apgPattern).toBe("disclosure");
  });

  it("returns a tree with parent-child structure", () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const main = makeEl("main"); append(body, main);
    const h1 = makeEl("h1"); append(main, h1); append(h1, "Title");

    const r = runWalker(root, WALKER_FN);
    expect(r.root).not.toBeNull();
    expect(r.root!.tag).toBe("html");
    expect(r.root!.children).toHaveLength(1);
    expect(r.root!.children[0]!.tag).toBe("body");
    expect(r.root!.children[0]!.children[0]!.tag).toBe("main");
    expect(r.root!.children[0]!.children[0]!.children[0]!.tag).toBe("h1");
  });

  it("captures focusable for tabindex and natural focusables", () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const tiPos = makeEl("div", { attrs: { tabindex: "0" } }); append(body, tiPos);
    const a = makeEl("a", { attrs: { href: "/x" } }); append(body, a);
    const inp = makeEl("input", { attrs: { type: "text" } }); append(body, inp);

    const r = runWalker(root, WALKER_FN);
    const all = flat(r.root!);
    expect(all.find((n) => n.tag === "div")!.focusable).toBe(true); // tabindex=0
    expect(all.find((n) => n.tag === "a")!.focusable).toBe(true);   // has href
    expect(all.find((n) => n.tag === "input")!.focusable).toBe(true);
  });
});

describe("extract-structure / edges extractor", () => {
  it("emits aria-owns, aria-flowsTo, commandfor, popovertarget, and link edges", () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const owns = makeEl("div", { id: "owns", attrs: { "aria-owns": "owned1 owned2" } });
    const flows = makeEl("div", { id: "flows", attrs: { "aria-flowsto": "target1" } });
    const cmd = makeEl("button", { id: "cmd", attrs: { commandfor: "dialog1" } });
    const pop = makeEl("button", { id: "pop", attrs: { popovertarget: "popover1" } });
    const a = makeEl("a", { id: "lnk", attrs: { href: "/somewhere" } });
    append(body, owns);
    append(body, flows);
    append(body, cmd);
    append(body, pop);
    append(body, a);
    append(body, makeEl("div", { id: "owned1" }));
    append(body, makeEl("div", { id: "owned2" }));
    append(body, makeEl("div", { id: "target1" }));
    append(body, makeEl("div", { id: "dialog1" }));
    append(body, makeEl("div", { id: "popover1" }));

    const r = runEdgesExtractor(root, EXTRACT_EDGES_FN);
    console.log('DEBUG result:', r);
    // Verify querySelectorAll works at all
    const sandbox = makeSandbox(root);
    const context = vm.createContext(sandbox);
    const q = vm.runInContext(`document.querySelectorAll("[id]").length`, context, { timeout: 1000 });
    console.log('DEBUG qsa length:', q);
    const sandbox2 = makeSandbox(root);
    const context2 = vm.createContext(sandbox2);
    const allIds = vm.runInContext(`Array.from(document.querySelectorAll("[id]")).map(e => e.id)`, context2, { timeout: 1000 });
    console.log('DEBUG all ids:', allIds);
    const kinds = new Map<string, number>();
    for (const e of r) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    expect(kinds.get("aria-owns")).toBe(2);
    expect(kinds.get("aria-flowsTo")).toBe(1);
    expect(kinds.get("commandfor")).toBe(1);
    expect(kinds.get("popovertarget")).toBe(1);
    expect(kinds.get("link")).toBe(1);
  });
});

describe("extract-structure / extractor", () => {
  let graph: Graph;
  let log: string[];

  beforeEach(() => {
    graph = new Graph();
    log = [];
  });

  async function runOn(root: MiniEl) {
    const pageNode = makePageNode("https://example.com/");
    graph.upsertPage(pageNode);
    const mockPage = makeMockPage(root);
    return await structuralExtractor.run({
      graph,
      page: mockPage as unknown as Page,
      pageNode,
      budget: { maxPages: 1, perPageTimeoutMs: 1, totalTimeoutMs: 1 },
      log: (m) => log.push(m),
    });
  }

  it("writes one AxNode per element and sets pageNode.axTreeRef", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const main = makeEl("main"); append(body, main);
    const h1 = makeEl("h1", { id: "page-h1" }); append(main, h1); append(h1, "Hello");
    const btn = makeEl("button", { id: "submit" }); append(main, btn); append(btn, "Go");
    const panel = makeEl("div", { id: "panel" }); append(main, panel);
    const trigger = makeEl("button", {
      id: "trigger",
      attrs: { "aria-controls": "panel", "aria-expanded": "true" },
    });
    append(main, trigger);

    const r = await runOn(root);
    expect(r.produced).toBe(true);

    // AxNodes: html, body, main, h1, button(Go), div(panel), button(trigger) = 7
    expect(graph.axCount).toBe(7);

    // Stable axIds based on elementId
    expect(graph.getAx("ax:page:https://example.com/:page-h1")).toBeDefined();
    expect(graph.getAx("ax:page:https://example.com/:submit")).toBeDefined();
    expect(graph.getAx("ax:page:https://example.com/:trigger")).toBeDefined();

    // h1 -> heading role
    const h1Node = graph.getAx("ax:page:https://example.com/:page-h1")!;
    expect(h1Node.role).toBe("heading");
    expect(h1Node.name).toBe("Hello");
    expect(h1Node.nameSource).toBe("content");

    // pageNode.axTreeRef is set: the root is the document root (the html
    // element), which has no id, so it falls back to the domOrder-based
    // axId (`n0`).
    const stored = graph.getPage("page:https://example.com/")!;
    expect(stored.axTreeRef.rootAxId).toBe("ax:page:https://example.com/:n0");
    expect(stored.axTreeRef.provenance).toBe("aria:tree-walk");

    // Log line
    expect(log[0]).toMatch(/ax-nodes=\d+ edges=\d+/);
  });

  it("emits an aria-controls edge from the trigger to the panel", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const panel = makeEl("div", { id: "panel" }); append(body, panel);
    const trigger = makeEl("button", {
      id: "trigger",
      attrs: { "aria-controls": "panel" },
    });
    append(body, trigger);

    await runOn(root);

    const fromId = "ax:page:https://example.com/:trigger";
    const toId = "ax:page:https://example.com/:panel";
    const edges = graph.edgesFrom(fromId, "aria-controls");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to).toBe(toId);
    expect(edges[0]!.provenance).toBe("aria:tree-walk");
  });

  it("emits a link edge for <a href>", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const a = makeEl("a", { id: "go", attrs: { href: "/somewhere" } });
    append(body, a);

    await runOn(root);

    const linkEdges = [...graph.axNodes()]
      .map((ax) => graph.edgesFrom(ax.id, "link"))
      .flat()
      .filter(Boolean);
    expect(linkEdges).toHaveLength(1);
    expect(linkEdges[0]!.to).toBe("ax:page:https://example.com/:href:/somewhere");
  });

  it("uses domOrder-based axId when the element has no id", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const main = makeEl("main"); append(body, main);
    const div = makeEl("div"); append(main, div); // no id
    const p = makeEl("p"); append(main, p); // no id

    await runOn(root);

    // html, body, main, div, p -> 5 nodes
    expect(graph.axCount).toBe(5);
    // The walker assigns domOrder across the whole tree, so:
    //   html=0, body=1, main=2, div=3, p=4
    const divByOrder = graph.getAx("ax:page:https://example.com/:n3");
    const pByOrder = graph.getAx("ax:page:https://example.com/:n4");
    expect(divByOrder).toBeDefined();
    expect(pByOrder).toBeDefined();
    // The AxNode stores the role of the underlying element
    expect(divByOrder!.role).toBe("presentation");
    expect(pByOrder!.role).toBe("presentation");
  });

  it("handles an empty page (no body) without throwing", async () => {
    const root = makeEl("html");
    const r = await runOn(root);
    expect(r.produced).toBe(true);
    expect(graph.axCount).toBe(1); // just the <html>
  });
});

describe("extract-structure / ED-04 a11y tree is a tree", () => {
  let graph: Graph;

  beforeEach(() => {
    graph = new Graph();
  });

  async function runOn(root: MiniEl) {
    const pageNode = makePageNode("https://example.com/");
    graph.upsertPage(pageNode);
    const mockPage = makeMockPage(root);
    return await structuralExtractor.run({
      graph,
      page: mockPage as unknown as Page,
      pageNode,
      budget: { maxPages: 1, perPageTimeoutMs: 1, totalTimeoutMs: 1 },
      log: () => undefined,
    });
  }

  it("parentAxId is null for the document root", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    await runOn(root);
    // The root is the html element; it has no elementId, so it falls back
    // to the domOrder-based axId `n0`. (The walker assigns domOrder starting
    // at 0 for the root.)
    const rootAx = graph.getAx("ax:page:https://example.com/:n0")!;
    expect(rootAx).toBeDefined();
    expect(rootAx.parentAxId).toBeNull();
  });

  it("parentAxId points to the parent axId for non-root nodes (with elementId)", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const main = makeEl("main", { id: "main" }); append(body, main);
    const h1 = makeEl("h1", { id: "page-h1" }); append(main, h1);
    const btn = makeEl("button", { id: "go" }); append(main, btn);

    await runOn(root);

    const h1Node = graph.getAx("ax:page:https://example.com/:page-h1")!;
    const btnNode = graph.getAx("ax:page:https://example.com/:go")!;
    const mainNode = graph.getAx("ax:page:https://example.com/:main")!;

    // main's parent is body (which has no id, so it uses n1 = body in
    // domOrder: html=0, body=1, main=2, h1=3, button=4).
    expect(mainNode.parentAxId).toBe("ax:page:https://example.com/:n1");
    // h1's parent is main.
    expect(h1Node.parentAxId).toBe("ax:page:https://example.com/:main");
    // button's parent is main.
    expect(btnNode.parentAxId).toBe("ax:page:https://example.com/:main");
  });

  it("emits an a11y:child-of edge from parent to child for every non-root node", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const nav = makeEl("nav", { id: "nav" }); append(body, nav);
    const a1 = makeEl("a", { id: "a1" }); append(nav, a1);
    const a2 = makeEl("a", { id: "a2" }); append(nav, a2);

    await runOn(root);

    const navAx = graph.getAx("ax:page:https://example.com/:nav")!;
    const a1Ax = graph.getAx("ax:page:https://example.com/:a1")!;
    const a2Ax = graph.getAx("ax:page:https://example.com/:a2")!;

    // nav has 2 children via a11y:child-of (a1, a2)
    const navChildren = graph.edgesFrom(navAx.id, "a11y:child-of");
    expect(navChildren).toHaveLength(2);
    const childTargets = navChildren.map((e) => e.to).sort();
    expect(childTargets).toEqual([a1Ax.id, a2Ax.id].sort());

    // a1's parent is nav (via reverse lookup)
    const a1Parents = graph.edgesTo(a1Ax.id, "a11y:child-of");
    expect(a1Parents).toHaveLength(1);
    expect(a1Parents[0]!.from).toBe(navAx.id);
  });

  it("a11y:child-of edge count = ax-count minus one (root has no parent edge)", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    const main = makeEl("main"); append(body, main);
    const s1 = makeEl("section", { id: "s1" }); append(main, s1);
    const s2 = makeEl("section", { id: "s2" }); append(main, s2);
    const p1 = makeEl("p"); append(s1, p1);
    const p2 = makeEl("p"); append(s2, p2);

    await runOn(root);

    const allChildOfEdges = [...graph.axNodes()]
      .flatMap((ax) => graph.edgesFrom(ax.id, "a11y:child-of"));
    expect(allChildOfEdges.length).toBe(graph.axCount - 1);
  });

  it("the root has no incoming a11y:child-of edge", async () => {
    const root = makeEl("html");
    const body = makeEl("body"); append(root, body);
    await runOn(root);
    const rootAx = graph.getAx("ax:page:https://example.com/:n0")!;
    const incoming = graph.edgesTo(rootAx.id, "a11y:child-of");
    expect(incoming).toHaveLength(0);
  });
});
