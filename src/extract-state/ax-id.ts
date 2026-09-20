/**
 * Canonical AxNode ID resolution — the SINGLE source of truth.
 *
 * **PR-8d (item 1).** Before PR-8d, every extractor (structural,
 * declared, observed, visual) re-implemented the same `axIdFor` rule
 * inline in its page-side script and, in some cases, on the Node side.
 * The implementations had drifted: only the structural extractor's
 * rule (`explicit id → ax:<pageId>:<elementId>`, else
 * `ax:<pageId>:n<structural-preorder-index>`) was authoritative, but
 * the other extractors also special-cased `<a href>` as
 * `ax:...:href:...` — an anonymous-anchor special case that broke
 * cross-extractor identity alignment.
 *
 * The binding rule (per PR-8d item 1, ratified 2026-08-30):
 *
 *   `explicit id → ax:<pageId>:<elementId>`,
 *   otherwise     `ax:<pageId>:n<structural-preorder-index>`.
 *
 * There is **no** `<a href>` special case. An anonymous anchor gets
 * the same `ax:<pageId>:n<index>` id as any other element at the same
 * pre-order slot, which is what every other extractor also computes.
 * This makes the id stable across all four extractors; a single
 * element in the page produces one canonical `ax:<pageId>:...` id
 * regardless of which extractor observed it.
 *
 * **The full-document walk.** The JS function `axIdWalkFn` in
 * `AXID_JS_BODY` does the same work as the structural extractor's
 * `WALKER_FN`: it walks `document.documentElement` pre-order via
 * `TreeWalker(SHOW_ELEMENT)`, building a `Map<Element, number>` from
 * element to its pre-order index (root is 0). It then exposes three
 * helpers to the page-side script:
 *
 *   - `axIdFor(pageId, el)`: returns the canonical id for one element.
 *   - `axIdWalk()`: array of every element in pre-order.
 *   - `axIdForAll()`: array of [el, axId] pairs (cached).
 *
 * The Node-side helpers (`canonicalAxIdFor`, `axIdForAttrs`) and the
 * in-page `AXID_JS_BODY` all share the same rule. The structural
 * extractor's `buildAxNode` (`src/extract-structure/structural.ts:450`)
 * is structurally identical to `canonicalAxIdFor`; both produce
 * `ax:<pageId>:<elementId>` or `ax:<pageId>:n<index>`.
 *
 * **The fall-back for dynamically inserted elements.** If an element
 * was inserted into the DOM *after* the pre-order walk ran (so
 * `idxOf` has no entry for it), the JS body falls back to
 * `ax:<pageId>:dyn:<tagName>:<siblingIndex>` where `siblingIndex` is
 * the zero-based position among the element's `previousElementSibling`
 * chain. This keeps the id deterministic across runs of the same
 * page, even if a script-side mutation adds elements after the walk.
 */
import type { MinimalDomElement } from "./dom-types.js";

/**
 * The in-process reference implementation. Takes a `pageId` (the
 * `page:<canonicalUrl>` form) and a `MinimalDomElement` (id + href
 * + domIndex). Returns the canonical axId.
 *
 * **No href fallback.** Per the binding rule, an element with no
 * `id` is named by its pre-order index alone, regardless of tag.
 */
export function canonicalAxIdFor(
  pageId: string,
  el: MinimalDomElement,
): string {
  if (el.id) return `ax:${pageId}:${el.id}`;
  return `ax:${pageId}:n${el.domIndex}`;
}

/**
 * The JS body that the BiDi in-page script inlines. Must produce
 * the same string as `canonicalAxIdFor` for the same inputs.
 *
 * The script is a single IIFE that:
 *   1. Walks `document.documentElement` pre-order via `TreeWalker`.
 *   2. Assigns each yielded element a sequential index (root = 0).
 *   3. Returns three functions to the page-side script:
 *        - `axIdFor(pageId, el)`: canonical id for one element.
 *        - `axIdWalk()`: array of every element in pre-order.
 *        - `axIdForAll()`: array of [el, axId] pairs (cached).
 *
 * Kept as a string constant so the BiDi realm (which cannot import
 * modules) can use it without a closure. The test
 * `test/extract-state/ax-id.test.ts` asserts the JS body and the TS
 * function produce the same output for a shared set of fixtures.
 *
 * **No href fallback.** Per the binding rule, the page-side `axIdFor`
 * uses only the explicit `id` or the pre-order index. The `<a href>`
 * anchor case is treated like any other element without an id.
 */
export const AXID_JS_BODY = `(function axIdWalkFn() {
  const root = document.documentElement;
  const orderList = [root];
  const idxOf = new Map();
  idxOf.set(root, 0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node;
  let i = 1;
  while ((node = walker.nextNode())) {
    orderList.push(node);
    idxOf.set(node, i);
    i++;
  }
  function axIdFor(pageId, el) {
    if (el.id) return 'ax:' + pageId + ':' + el.id;
    const idx = idxOf.get(el);
    if (idx === undefined) {
      // Element was not in the pre-order walk (e.g. dynamically inserted
      // after walk). Fall back to a stable hash of tagName + position
      // in its parent's child list so the id is at least deterministic.
      const parent = el.parentElement;
      let sibIdx = 0;
      if (parent) {
        for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++;
      }
      return 'ax:' + pageId + ':dyn:' + (el.tagName || '') + ':' + sibIdx;
    }
    return 'ax:' + pageId + ':n' + idx;
  }
  function axIdWalk() { return orderList; }
  function axIdForAll() {
    const out = [];
    for (let j = 0; j < orderList.length; j++) {
      out.push([orderList[j], axIdFor('', orderList[j]).replace(/^ax:/, '')]);
    }
    return out;
  }
  return { axIdFor: axIdFor, axIdWalk: axIdWalk, axIdForAll: axIdForAll };
})`;

/**
 * Compute the axId the page-side script would emit for a given
 * element id + tag + href + pre-order index. This is the "pre-built"
 * form used by the observed/visual extractors when they don't have a
 * full DOM element in scope (e.g. inside the BiDi realm after
 * `getAttribute`). **No href fallback** per the binding rule.
 */
export function axIdForAttrs(
  pageId: string,
  elementId: string | null,
  _tagName: string,
  _href: string | null,
  domIndex: number,
): string {
  if (elementId) return `ax:${pageId}:${elementId}`;
  return `ax:${pageId}:n${domIndex}`;
}

/**
 * The interface the page-side script receives from `AXID_JS_BODY`.
 * The declared/observed/visual extractors consume this through
 * `BiDi script.callFunction` with no arguments; the result is the
 * `axIdRuntime` object below. They then call `axIdFor(pageId, el)`
 * to mint a canonical id.
 */
export interface AxIdRuntime {
  axIdFor: (pageId: string, el: Element) => string;
  axIdWalk: () => Element[];
  axIdForAll: () => Array<[Element, string]>;
}
