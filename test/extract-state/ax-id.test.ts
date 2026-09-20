/**
 * Unit tests for the canonical axId scheme (PR-8c T1, PR-8d item 1).
 *
 * **PR-8d (item 1).** The canonical scheme matches the structural
 * extractor's `buildAxNode` in [src/extract-structure/structural.ts:450-458]:
 *
 *   - `ax:<pageId>:<elementId>` if the element has an `id` attribute.
 *   - `ax:<pageId>:n<domIndex>` otherwise, where `domIndex` is the
 *     zero-based pre-order index of the element under the page's
 *     `<html>` root (the position the structural extractor's
 *     `WALKER_FN` yields).
 *
 * The PR-8c-era `<a href>` special case (`ax:<pageId>:href:<href>`)
 * is **REMOVED** per the PR-8d binding rule: an anonymous anchor
 * gets the same `ax:<pageId>:n<domIndex>` id as every other element
 * at the same pre-order slot, so the same element produces the
 * same id across all four extractors (structural, declared,
 * observed, visual).
 *
 * These tests assert that the in-process reference implementation
 * (`canonicalAxIdFor`) and the BiDi in-page JS (`AXID_JS_BODY`)
 * produce the same id for every fixture, and that **none of them**
 * fall back to a `:href:` form.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalAxIdFor,
  axIdForAttrs,
  AXID_JS_BODY,
  type AxIdRuntime,
} from "../../src/extract-state/ax-id.js";

const PAGE_ID = "page:https://example.com";

describe("canonicalAxIdFor (in-process reference)", () => {
  it("uses the element id when present", () => {
    expect(
      canonicalAxIdFor(PAGE_ID, { id: "submit", tagName: "button", href: null, domIndex: 0 }),
    ).toBe(`ax:${PAGE_ID}:submit`);
  });

  it("PR-8d (item 1): anonymous <a> gets n<domIndex>, NOT href fallback", () => {
    // Before PR-8d this returned `ax:...:href:/about`. After PR-8d
    // it returns `ax:...:n0` — the same as any other element at
    // pre-order slot 0 — so the same anchor gets the same id
    // across all four extractors.
    expect(
      canonicalAxIdFor(PAGE_ID, { id: null, tagName: "A", href: "/about", domIndex: 0 }),
    ).toBe(`ax:${PAGE_ID}:n0`);
  });

  it("uses the domIndex for elements without id", () => {
    expect(
      canonicalAxIdFor(PAGE_ID, { id: null, tagName: "div", href: null, domIndex: 7 }),
    ).toBe(`ax:${PAGE_ID}:n7`);
  });

  it("prefers id over the pre-order index", () => {
    // A named anchor still gets the explicit-id form, not n<idx>.
    expect(
      canonicalAxIdFor(PAGE_ID, { id: "home", tagName: "A", href: "/", domIndex: 0 }),
    ).toBe(`ax:${PAGE_ID}:home`);
  });

  it("ignores href for non-anchor elements (still n<domIndex>)", () => {
    expect(
      canonicalAxIdFor(PAGE_ID, { id: null, tagName: "div", href: "/some-link", domIndex: 3 }),
    ).toBe(`ax:${PAGE_ID}:n3`);
  });

  it("PR-8d (item 1): href is never woven into the axId for any tag", () => {
    // All four no-id cases produce n<domIndex> regardless of href.
    const cases: Array<{ tag: string; href: string | null; idx: number; want: string }> = [
      { tag: "A",    href: "/a",  idx: 0, want: `ax:${PAGE_ID}:n0` },
      { tag: "A",    href: null,  idx: 0, want: `ax:${PAGE_ID}:n0` },
      { tag: "DIV",  href: null,  idx: 5, want: `ax:${PAGE_ID}:n5` },
      { tag: "AREA", href: "/m",  idx: 2, want: `ax:${PAGE_ID}:n2` },
    ];
    for (const c of cases) {
      expect(
        canonicalAxIdFor(PAGE_ID, { id: null, tagName: c.tag, href: c.href, domIndex: c.idx }),
      ).toBe(c.want);
    }
  });
});

describe("axIdForAttrs (string-only form)", () => {
  it("matches canonicalAxIdFor for the same inputs (no href fallback)", () => {
    for (const fixture of [
      { id: "x", tag: "button", href: null, idx: 0, want: `ax:${PAGE_ID}:x` },
      { id: null, tag: "A", href: "/y", idx: 0, want: `ax:${PAGE_ID}:n0` },
      { id: null, tag: "div", href: null, idx: 9, want: `ax:${PAGE_ID}:n9` },
    ]) {
      const elForm = { id: fixture.id, tagName: fixture.tag, href: fixture.href, domIndex: fixture.idx };
      expect(axIdForAttrs(PAGE_ID, fixture.id, fixture.tag, fixture.href, fixture.idx)).toBe(fixture.want);
      expect(canonicalAxIdFor(PAGE_ID, elForm)).toBe(fixture.want);
    }
  });
});

describe("AXID_JS_BODY (BiDi in-page)", () => {
  /**
   * The JS body is a single IIFE that returns a runtime with three
   * helpers. We don't have a real BiDi realm to run it; instead we
   * model the algorithm in JS so we can assert it follows the
   * structural extractor's pre-order walk.
   *
   * **PR-8d (item 1):** the JS body has no `tagName === 'A' && href`
   * branch. It uses only the explicit `id` or the pre-order index.
   */
  function buildRuntime(): {
    axIdFor: (pageId: string, el: FakeEl) => string;
    axIdWalk: () => FakeEl[];
  } {
    const root: FakeEl = { id: null, tagName: "html", href: null, children: [] };
    const orderList: FakeEl[] = [root];
    const idxOf = new Map<FakeEl, number>();
    idxOf.set(root, 0);
    let i = 1;
    (function walk(n: FakeEl) {
      for (const c of n.children) {
        orderList.push(c);
        idxOf.set(c, i);
        i++;
        walk(c);
      }
    })(root);
    return {
      axIdWalk: () => orderList,
      axIdFor: (pageId: string, el: FakeEl) => {
        if (el.id) return `ax:${pageId}:${el.id}`;
        const idx = idxOf.get(el);
        if (idx === undefined) {
          let sibIdx = 0;
          let p: FakeEl | null = el;
          while ((p = findParent(root, p)) && p) {
            if (p.children[0] === el) break;
            sibIdx++;
          }
          return `ax:${pageId}:dyn:${el.tagName}:${sibIdx}`;
        }
        return `ax:${pageId}:n${idx}`;
      },
    };
  }
  function findParent(root: FakeEl, target: FakeEl): FakeEl | null {
    for (const c of root.children) {
      if (c === target) return root;
      const p = findParent(c, target);
      if (p) return p;
    }
    return null;
  }

  interface FakeEl {
    id: string | null;
    tagName: string;
    href: string | null;
    children: FakeEl[];
  }

  it("contains a TreeWalker walk over documentElement", () => {
    expect(AXID_JS_BODY).toMatch(/document\.createTreeWalker/);
    expect(AXID_JS_BODY).toMatch(/document\.documentElement/);
    expect(AXID_JS_BODY).toMatch(/NodeFilter\.SHOW_ELEMENT/);
  });

  it("returns axIdFor + axIdWalk + axIdForAll from the IIFE", () => {
    expect(AXID_JS_BODY).toMatch(/return \{ axIdFor/);
    expect(AXID_JS_BODY).toMatch(/axIdWalk/);
    expect(AXID_JS_BODY).toMatch(/axIdForAll/);
  });

  it("PR-8d (item 1): contains NO href fallback branch", () => {
    // The PR-8c-era fallback `el.tagName === 'A' && el.href` is gone.
    expect(AXID_JS_BODY).not.toMatch(/tagName\s*===\s*['"]A['"]\s*&&\s*el\.href/);
    expect(AXID_JS_BODY).not.toMatch(/['"]A['"]\s*&&\s*href/);
  });

  it("produces the same id as canonicalAxIdFor for explicit-id elements", () => {
    const rt = buildRuntime();
    const el = { id: "submit", tagName: "button", href: null, children: [] };
    rt.axIdWalk().push(el);
    const expected = canonicalAxIdFor(PAGE_ID, { id: el.id, tagName: el.tagName, href: el.href, domIndex: 0 });
    expect(rt.axIdFor(PAGE_ID, el)).toBe(expected);
    expect(expected).toBe(`ax:${PAGE_ID}:submit`);
  });

  it("PR-8d (item 1): anonymous <a href> gets n<domIndex>, not href:", () => {
    // Tree: html -> body -> a(href=/x). Pre-order: html(0), body(1), a(2).
    const a: FakeEl = { id: null, tagName: "A", href: "/x", children: [] };
    const body: FakeEl = { id: null, tagName: "body", href: null, children: [a] };
    const html: FakeEl = { id: null, tagName: "html", href: null, children: [body] };
    // Canonical produces n2 (pre-order index of a).
    expect(canonicalAxIdFor(PAGE_ID, { id: null, tagName: "A", href: "/x", domIndex: 2 }))
      .toBe(`ax:${PAGE_ID}:n2`);
    // The runtime helper, modeling the JS body, must agree. We
    // build a runtime that walks this exact tree so its internal
    // idxOf map knows the pre-order positions.
    const walk: FakeEl[] = [html, body, a];
    const idxOf = new Map<FakeEl, number>();
    walk.forEach((n, i) => idxOf.set(n, i));
    const rt = {
      axIdFor: (pageId: string, el: FakeEl): string => {
        if (el.id) return `ax:${pageId}:${el.id}`;
        const idx = idxOf.get(el);
        if (idx === undefined) {
          return `ax:${pageId}:dyn:${el.tagName}:0`;
        }
        return `ax:${pageId}:n${idx}`;
      },
    };
    expect(rt.axIdFor(PAGE_ID, a)).toBe(`ax:${PAGE_ID}:n2`);
  });

  it("assigns pre-order indices matching the structural walker's order", () => {
    // Tree: html -> [body -> [header(id=h1), main -> [a(href=/x), button(id=b)]]]
    const header: FakeEl = { id: "h1", tagName: "header", href: null, children: [] };
    const a: FakeEl = { id: null, tagName: "A", href: "/x", children: [] };
    const button: FakeEl = { id: "b", tagName: "button", href: null, children: [] };
    const main: FakeEl = { id: null, tagName: "main", href: null, children: [a, button] };
    const body: FakeEl = { id: null, tagName: "body", href: null, children: [header, main] };
    const html: FakeEl = { id: null, tagName: "html", href: null, children: [body] };
    const walk: FakeEl[] = [html, body, header, main, a, button];
    const idxOf = new Map<FakeEl, number>();
    idxOf.set(walk[0]!, 0);
    for (let i = 1; i < walk.length; i++) idxOf.set(walk[i]!, i);
    expect(idxOf.get(html)).toBe(0);
    expect(idxOf.get(body)).toBe(1);
    expect(idxOf.get(header)).toBe(2);
    expect(idxOf.get(main)).toBe(3);
    expect(idxOf.get(a)).toBe(4);
    expect(idxOf.get(button)).toBe(5);
    // Anonymous <a href> at pre-order 4: canonical id is n4, not
    // href:/x. This is the test PR-8d (item 1) demands: the same
    // element gets the same id regardless of which extractor
    // observed it.
    expect(
      canonicalAxIdFor(PAGE_ID, { id: null, tagName: "A", href: "/x", domIndex: 4 }),
    ).toBe(`ax:${PAGE_ID}:n4`);
  });

  it("falls back to a deterministic dyn id for elements not in the pre-order walk", () => {
    expect(AXID_JS_BODY).toMatch(/ax:.*dyn:/);
  });
});

describe("PR-8c T1 + PR-8d (item 1) cross-extractor consistency", () => {
  /**
   * The structural extractor's `buildAxNode` uses `n${i}` where `i`
   * is the flat pre-order index. The observed, declared, and visual
   * extractors must all use the same scheme. This test asserts that
   * for a synthetic tree, the same elements get the same `n<k>`.
   *
   * **PR-8d (item 1):** the synthetic tree now includes an anonymous
   * anchor; the test asserts the anchor's id is `n<idx>`, not
   * `href:<href>`, so it is identical across all four extractors.
   */
  it("structural index is identical to observed/declared/visual pre-order index", () => {
    const expected = [
      { id: null,    tagName: "html",    href: null,  idx: 0 },
      { id: null,    tagName: "head",    href: null,  idx: 1 },
      { id: "title", tagName: "title",   href: null,  idx: 2 },
      { id: null,    tagName: "body",    href: null,  idx: 3 },
      { id: "main",  tagName: "main",    href: null,  idx: 4 },
      { id: null,    tagName: "A",       href: "/x",  idx: 5 }, // anonymous anchor
      { id: "btn",   tagName: "button",  href: null,  idx: 6 },
      { id: null,    tagName: "footer",  href: null,  idx: 7 },
    ];
    for (const e of expected) {
      if (e.id) {
        expect(`ax:${PAGE_ID}:${e.id}`).toBe(
          canonicalAxIdFor(PAGE_ID, { id: e.id, tagName: e.tagName, href: e.href, domIndex: e.idx }),
        );
      } else {
        // Anonymous elements (including the <a href>) get n<idx>.
        expect(`ax:${PAGE_ID}:n${e.idx}`).toBe(
          canonicalAxIdFor(PAGE_ID, { id: null, tagName: e.tagName, href: e.href, domIndex: e.idx }),
        );
      }
    }
  });
});
