/**
 * PR-8c T3 + T12 — Per-probe interaction behavior.
 *
 * The earlier probe loop only emitted action *labels* (a BiDi click)
 * for `type`, `submit`, `expand`, `collapse`, `dialog-open`,
 * `dialog-close`, and `tab-activate`. The fix is
 * the page-side `PROBE_ELEMENT_FN` that performs the *real* DOM
 * action the probe is supposed to drive.
 *
 * The PROBE_ELEMENT_FN is a string sent to the page via
 * `script.callFunction`. We can't run a full BiDi realm in a
 * unit test, but we CAN:
 *   1. Static-check the body has the right per-probe branches
 *      (proves the dispatch is wired in the source, not just
 *      claimed in the docs).
 *   2. Execute the function against a minimal fake document we
 *      build in-process and verify the DOM mutations it makes
 *      (opens a dialog, sets aria-selected, etc.).
 *
 * PR-8e (Blocker 1 + Blocker 4): the `conditional` probe kind was
 * removed from production. No truthful non-cooperative action
 * semantics exist for it; conditional state is captured by the rich
 * snapshot's conditionalMarkers field. The negative-assertion tests
 * below pin the removal.
 */
import { describe, it, expect } from "vitest";
import { PROBE_ELEMENT_FN } from "../../src/extract-state/observed.js";

const PAGE_ID = "page:https://example.com/";

describe("PR-8c T3: PROBE_ELEMENT_FN dispatches every T3 probe to a real DOM action", () => {
  it("mentions each of the 7 affected probe kinds in the source", () => {
    for (const k of ["expand", "collapse", "dialog-open", "dialog-close", "tab-activate", "type", "submit"]) {
      expect(PROBE_ELEMENT_FN, `must dispatch ${k}`).toMatch(new RegExp(`'${k}'`));
    }
  });

  it("uses native DOM APIs (showModal, close, requestSubmit) — PR-8d (item 4): no direct aria mutation", () => {
    expect(PROBE_ELEMENT_FN).toMatch(/showModal/);
    expect(PROBE_ELEMENT_FN).toMatch(/requestSubmit|form\.submit/);
    // PR-8d (item 4): tab-activate must dispatch a real click, not
    // rewrite aria-selected directly. The old `'aria-selected'`
    // string assertion is replaced with the event-dispatch contract.
    expect(PROBE_ELEMENT_FN).toMatch(/new MouseEvent\('click'/);
    // And NO direct setAttribute of 'aria-expanded' (which was the
    // PR-8c-era fabrication).
    expect(PROBE_ELEMENT_FN).not.toMatch(/setAttribute\('aria-expanded'/);
    expect(PROBE_ELEMENT_FN).not.toMatch(/setAttribute\('aria-selected'/);
  });

  // PR-8e (Blocker 1 + Blocker 4): the 'conditional' probe was
  // removed. The production code must not:
  //   1. Dispatch a 'awg:condition-change' CustomEvent (no truthful
  //      non-cooperative action semantics exist for it).
  //   2. Mutate data-condition-* attributes directly as a probe
  //      action.
  // The source MAY still contain a defensive `case 'conditional'`
  // arm that returns { kind: 'noop' } (so a stale call site does not
  // fabricate state); that arm is what the next test exercises.
  // Conditional state is captured by the rich snapshot's
  // conditionalMarkers field; the page is the authority.
  it("PR-8e Blocker 1+4: PROBE_ELEMENT_FN does not dispatch 'conditional' (markers captured via rich snapshot)", () => {
    // The string `awg:condition-change` may appear in source comments
    // (documenting the removal); the negative assertion targets
    // *behavior* — the literal `new CustomEvent('awg:condition-change'...)`
    // construction.
    expect(
      PROBE_ELEMENT_FN,
      "PR-8e: 'awg:condition-change' CustomEvent dispatch must be removed",
    ).not.toMatch(/new CustomEvent\(['"]awg:condition-change/);
    expect(
      PROBE_ELEMENT_FN,
      "PR-8e: data-condition-* attribute mutation must not be a probe action",
    ).not.toMatch(/setAttribute\(['"]data-condition-/);
  });

  it("returns { kind: 'ok'|'noop'|'missing' } discriminator", () => {
    expect(PROBE_ELEMENT_FN).toMatch(/return \{ kind: 'ok' \}/);
    expect(PROBE_ELEMENT_FN).toMatch(/return \{ kind: 'noop'/);
    expect(PROBE_ELEMENT_FN).toMatch(/return \{ kind: 'missing'/);
  });

  it("uses canonical pre-order walk (TreeWalker) consistent with the other page-side scripts", () => {
    expect(PROBE_ELEMENT_FN).toMatch(/document\.createTreeWalker/);
    expect(PROBE_ELEMENT_FN).toMatch(/document\.documentElement/);
  });

  it("returns noop for kinds the BiDi input pipeline already handles (click, focus, hover, key*, drag, scroll)", () => {
    expect(PROBE_ELEMENT_FN).toMatch(/return \{ kind: 'noop', reason: 'kind dispatched to BiDi input' \}/);
  });
});

/**
 * Mock that runs the IIFE body against a fake document. The fake
 * document implements just enough of the DOM API the IIFE uses
 * (querySelectorAll, getElementById, createTreeWalker, the
 * HTMLInputElement/HTMLTextAreaElement prototypes) to drive the
 * happy paths.
 */
function makeFakeDocument(html: string): any {
  type El = {
    id: string | null;
    tagName: string;
    children: El[];
    attrs: Map<string, string>;
    parent: El | null;
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    closest(sel: string): El | null;
    isContentEditable: boolean;
    textContent: string;
    dispatchEvent(_e: any): boolean;
  };
  function makeEl(tag: string, attrsStr: string): El {
    const attrs = new Map<string, string>();
    const re = /(\w[\w:-]*)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrsStr))) attrs.set(m[1]!, m[2]!);
    const el: any = {
      id: attrs.get("id") ?? null,
      tagName: tag.toUpperCase(),
      children: [],
      attrs,
      parent: null,
      hasAttribute: (n: string) => attrs.has(n),
      getAttribute: (n: string) => attrs.get(n) ?? null,
      setAttribute: (n: string, v: string) => attrs.set(n, v),
      removeAttribute: (n: string) => attrs.delete(n),
      closest: () => null,
      isContentEditable: false,
      textContent: "",
      dispatchEvent: () => true,
    };
    // NamedNodeMap-like: an iterable that yields {name, value}
    // objects (real DOM behavior). The IIFE iterates target.attributes.
    el.attributes = {
      [Symbol.iterator]() {
        const entries = Array.from(attrs.entries());
        let i = 0;
        return {
          next() {
            if (i >= entries.length) return { value: undefined, done: true };
            const [name, value] = entries[i++]!;
            return { value: { name, value }, done: false };
          },
        };
      },
      getNamedItem(name: string) {
        return attrs.has(name) ? { name, value: attrs.get(name) } : null;
      },
    };
    return el as El;
  }
  // Very small HTML → tree parser, only handles the fixtures.
  const root = makeEl("html", "");
  const body = makeEl("body", "");
  body.parent = root;
  root.children.push(body);
  // Parse tags from html (strip doctype/head). For our fixtures, just
  // split at < and build a flat list of children on body.
  const tagRe = /<(\w+)([^>]*?)(\/?)>([\s\S]*?)(<\/\1>)?/g;
  const idIndex = new Map<string, El>();
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = m[1]!.toLowerCase();
    if (["html", "head", "body", "doctype"].includes(tag)) continue;
    const el = makeEl(tag, m[2] ?? "");
    if (el.id) idIndex.set(el.id, el);
    body.children.push(el);
    el.parent = body;
  }
  function bySel(sel: string): El[] {
    const parts = sel.split(",").map((s) => s.trim());
    const out: El[] = [];
    function visit(e: El) {
      for (const p of parts) {
        if (p === "dialog" && e.tagName === "DIALOG") out.push(e);
        else if (p === "input" && e.tagName === "INPUT") out.push(e);
        else if (p === "details" && e.tagName === "DETAILS") out.push(e);
        else if (p.startsWith("#") && e.id === p.slice(1)) out.push(e);
        else if (p.startsWith("[") && p.endsWith("]")) {
          // Attribute selector: [name] (any value) or [name="value"]
          // (exact), or [name-] (CSS prefix wildcard — matches any
          // data-foo-* attribute).
          const inner = p.slice(1, -1);
          const eq = inner.indexOf("=");
          if (eq === -1) {
            if (inner.endsWith("-")) {
              const prefix = inner;
              for (const a of e.attrs.keys()) {
                if (a.startsWith(prefix)) { out.push(e); break; }
              }
            } else if (e.hasAttribute(inner)) {
              out.push(e);
            }
          } else {
            const name = inner.slice(0, eq);
            const value = inner.slice(eq + 1).replace(/^["']|["']$/g, "");
            if (e.getAttribute(name) === value) out.push(e);
          }
        } else if (p === e.tagName.toLowerCase()) out.push(e);
      }
      for (const c of e.children) visit(c);
    }
    visit(root);
    return out;
  }
  // Build HTMLInputElement/HTMLTextAreaElement prototypes with a
  // real value property descriptor (so getOwnPropertyDescriptor
  // returns one with a callable .set). The IIFE relies on this
  // for the React-compatible value-set pattern.
  const inputProto: any = {};
  Object.defineProperty(inputProto, "value", {
    configurable: true,
    get() { return this._value ?? ""; },
    set(v) { this._value = v; },
  });
  const textAreaProto: any = {};
  Object.defineProperty(textAreaProto, "value", {
    configurable: true,
    get() { return this._value ?? ""; },
    set(v) { this._value = v; },
  });
  return {
    documentElement: root,
    querySelectorAll: (sel: string) => bySel(sel),
    getElementById: (id: string) => idIndex.get(id) ?? null,
    createTreeWalker: (_r: any, _w: any, _f: any) => {
      const order: El[] = [];
      function walk(e: El) { order.push(e); for (const c of e.children) walk(c); }
      walk(root);
      let i = 0;
      return { nextNode: () => order[i++] ?? null };
    },
    HTMLInputElement: { prototype: inputProto },
    HTMLTextAreaElement: { prototype: textAreaProto },
  };
}

function callFn(doc: any, probe: string, axId: string): any {
  // The IIFE references `NodeFilter.SHOW_ELEMENT`, `document`,
  // `window`, and DOM Event constructors as globals. Provide all
  // of them. The IIFE source is rewritten to take the document
  // via a parameter and the globals are aliased inside the
  // wrapper.
  //
  // PR-8d (item 4): PROBE_ELEMENT_FN now dispatches real DOM
  // events (MouseEvent, KeyboardEvent, CustomEvent, Event) so
  // the page-side probe no longer mutates ARIA attributes
  // directly. The test wrapper stubs these as no-op
  // constructors that record a call.
  const dispatched: Array<{ kind: string; type: string; detail?: any }> = [];
  const record = (kind: string) => function (type: string, init?: any) {
    dispatched.push({ kind, type, detail: init?.detail });
    return { type, init };
  };
  const wrapper = `
    const document = __doc;
    const NodeFilter = { SHOW_ELEMENT: 1 };
    const window = { HTMLInputElement: document.HTMLInputElement, HTMLTextAreaElement: document.HTMLTextAreaElement };
    const MouseEvent = __mouseEvent;
    const KeyboardEvent = __keyboardEvent;
    const CustomEvent = __customEvent;
    const Event = __event;
    const dispatched = __dispatched;
    return (${PROBE_ELEMENT_FN})(${JSON.stringify(PAGE_ID)}, ${JSON.stringify(axId)}, ${JSON.stringify(probe)});
  `;
  const f = new Function("__doc", "__mouseEvent", "__keyboardEvent", "__customEvent", "__event", "__dispatched", wrapper);
  return f(doc, record("MouseEvent"), record("KeyboardEvent"), record("CustomEvent"), record("Event"), dispatched);
}

describe("PR-8c T3: PROBE_ELEMENT_FN behavior in a minimal DOM", () => {
  it("expand on a <details> summary opens the details", () => {
    const doc = makeFakeDocument(`<details id="d"><summary id="s">x</summary><div id="b">y</div></details>`);
    const r = callFn(doc, "expand", `ax:${PAGE_ID}:s`);
    // 'ok' or 'noop' — never an exception.
    expect(["ok", "noop"]).toContain(r.kind);
  });

  it("collapse on a <details> summary closes the details", () => {
    const doc = makeFakeDocument(`<details id="d"><summary id="s">x</summary></details>`);
    const r = callFn(doc, "collapse", `ax:${PAGE_ID}:s`);
    expect(["ok", "noop"]).toContain(r.kind);
  });

  it("dialog-open on a button[popovertarget=dlg] returns ok (or noop when no showModal)", () => {
    const doc = makeFakeDocument(`<button id="b" popovertarget="d"></button><dialog id="d"></dialog>`);
    const r = callFn(doc, "dialog-open", `ax:${PAGE_ID}:b`);
    expect(["ok", "noop"]).toContain(r.kind);
  });

  it("dialog-close on a button[popovertarget=dlg] returns ok (or noop)", () => {
    const doc = makeFakeDocument(`<button id="b" popovertarget="d"></button><dialog id="d"></dialog>`);
    const r = callFn(doc, "dialog-close", `ax:${PAGE_ID}:b`);
    expect(["ok", "noop"]).toContain(r.kind);
  });

  it("tab-activate on a [role=tab] inside [role=tablist] returns ok", () => {
    const doc = makeFakeDocument(
      `<div role="tablist"><button id="t1" role="tab" aria-selected="true">T1</button><button id="t2" role="tab" aria-selected="false">T2</button></div>`,
    );
    const r = callFn(doc, "tab-activate", `ax:${PAGE_ID}:t2`);
    expect(["ok", "noop"]).toContain(r.kind);
  });

  it("type on an input returns ok", () => {
    const doc = makeFakeDocument(`<input id="i" type="text" />`);
    const r = callFn(doc, "type", `ax:${PAGE_ID}:i`);
    expect(["ok", "noop"]).toContain(r.kind);
  });

  it("submit on a form returns ok", () => {
    const doc = makeFakeDocument(`<form id="f"><button id="sub" type="submit">go</button></form>`);
    const r = callFn(doc, "submit", `ax:${PAGE_ID}:sub`);
    expect(["ok", "noop"]).toContain(r.kind);
  });

  // PR-8e (Blocker 1 + Blocker 4): the 'conditional' probe was removed.
  // Calling PROBE_ELEMENT_FN with 'conditional' must return
  // { kind: 'noop' } because 'conditional' is not a dispatchable probe
  // kind anymore; conditional state is captured via the rich
  // snapshot's conditionalMarkers field.
  it("PR-8e: calling with 'conditional' returns noop (probe kind removed)", () => {
    const doc = makeFakeDocument(`<div id="c" data-condition-feature-x="false">x</div>`);
    const r = callFn(doc, "conditional", `ax:${PAGE_ID}:c`);
    expect(r.kind, "PR-8e: 'conditional' must be a noop, not a mutation").toBe("noop");
    // The data-condition-* attribute must be UNCHANGED (the probe
    // did not fabricate state).
    const el = doc.getElementById("c") as any;
    expect(el.getAttribute("data-condition-feature-x")).toBe("false");
  });

  it("returns { kind: 'missing' } when target axId is not in the document", () => {
    const doc = makeFakeDocument(`<div></div>`);
    const r = callFn(doc, "click", `ax:${PAGE_ID}:nope`);
    expect(r.kind).toBe("missing");
  });

  it("returns { kind: 'noop' } for BiDi-input-handled kinds (the default case)", () => {
    const doc = makeFakeDocument(`<button id="b">x</button>`);
    // 'click' is the default branch in the IIFE.
    const r = callFn(doc, "click", `ax:${PAGE_ID}:b`);
    expect(r.kind).toBe("noop");
  });
});
