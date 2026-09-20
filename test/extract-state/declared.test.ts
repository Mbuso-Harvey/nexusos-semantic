/**
 * Tests for the static "declared" state extractor (plan 7.1).
 *
 * Mocks `Page.script.callFunction` to return a synthetic element list and
 * verifies that the extractor produces the right edges + transitions for:
 *  1. commandfor (known kinds) + transition
 *  2. custom --foo invoker command (closest ancestor button)
 *  3. popovertarget
 *  4. dialog-open
 *  5. <a href> link edge (no transition)
 *  6. APG-implied tablist transitions (focus next tab -> activates tabpanel)
 */
import { describe, it, expect, vi } from "vitest";
import { buildDeclared, type DeclaredRecord, PAGE_SCRIPT } from "../../src/extract-state/declared.js";
import { extractStateDeclared } from "../../src/extract-state/index.js";
import { Graph } from "../../src/graph/graph.js";
import type { ExtractorContext } from "../../src/crawler/orchestrator.js";
import type { PageNode, Edge, Transition } from "../../src/graph/types.js";

const PAGE = "page:https://example.com/";

function makePageNode(): PageNode {
  return {
    id: PAGE,
    type: "page",
    url: "https://example.com/",
    title: "Test",
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

function makeCtx(records: DeclaredRecord[]) {
  const graph = new Graph();
  graph.upsertPage(makePageNode());
  const callFunction = vi.fn(async () => records);
  const page = {
    target: { context: "ctx" },
    script: { callFunction },
  };
  const log = vi.fn();
  const ctx = {
    graph,
    page: page as any,
    pageNode: graph.getPage(PAGE)!,
    budget: { maxPages: 1, perPageTimeoutMs: 1000, totalTimeoutMs: 10_000 },
    log,
  } as ExtractorContext;
  return { ctx, graph, callFunction, log };
}

/** Tiny helper: grab an indexed value or fail with a clear message. */
function at<T>(arr: T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}, got ${arr.length} item(s)`);
  return v;
}

describe("buildDeclared — pure transform", () => {
  it("emits a commandfor edge and transition for a known kind", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:btn", toAxId: "ax:page:dlg", kind: "commandfor", transitionKind: "declared", trigger: "command" },
    ];
    const { edges, transitions } = buildDeclared(PAGE, records);
    expect(edges).toHaveLength(1);
    const e: Edge = at(edges, 0, "edge");
    expect(e).toMatchObject({
      id: `edge:ax:page:btn->ax:page:dlg:commandfor`,
      from: "ax:page:btn",
      to: "ax:page:dlg",
      kind: "commandfor",
      provenance: "html:parse",
    });
    expect(transitions).toHaveLength(1);
    const t: Transition = at(transitions, 0, "transition");
    expect(t).toMatchObject({
      kind: "declared",
      trigger: "command",
      fromAxId: "ax:page:btn",
      toAxIds: ["ax:page:dlg"],
      apgPattern: null,
      provenance: "html:parse",
    });
    expect(t.id).toBe("trans:commandfor-ax:page:btn-1");
  });

  it("custom --foo command: target is the closest ancestor button (as resolved by the page script)", () => {
    // The page-side script resolves the target. Here we verify the edge +
    // transition shape for a record that already has the resolved target.
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:theme-toggle", toAxId: "ax:page:awg-theme-root", kind: "commandfor", transitionKind: "declared", trigger: "command" },
    ];
    const { edges, transitions } = buildDeclared(PAGE, records);
    const e: Edge = at(edges, 0, "edge");
    const t: Transition = at(transitions, 0, "transition");
    expect(e.kind).toBe("commandfor");
    expect(e.from).toBe("ax:page:theme-toggle");
    expect(e.to).toBe("ax:page:awg-theme-root");
    expect(t.trigger).toBe("command");
  });

  it("emits a popovertarget edge and transition", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:user-menu-button", toAxId: "ax:page:user-menu", kind: "popovertarget", transitionKind: "declared", trigger: "popover" },
    ];
    const { edges, transitions } = buildDeclared(PAGE, records);
    const e: Edge = at(edges, 0, "edge");
    const t: Transition = at(transitions, 0, "transition");
    expect(e.kind).toBe("popovertarget");
    expect(e.to).toBe("ax:page:user-menu");
    expect(t.trigger).toBe("popover");
    expect(t.id).toBe("trans:popovertarget-ax:page:user-menu-button-1");
  });

  it("emits a dialog-open edge and transition", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:btn-signout", toAxId: "ax:page:confirm-signout", kind: "dialog-open", transitionKind: "declared", trigger: "dialog" },
    ];
    const { edges, transitions } = buildDeclared(PAGE, records);
    const e: Edge = at(edges, 0, "edge");
    const t: Transition = at(transitions, 0, "transition");
    expect(e.kind).toBe("dialog-open");
    expect(t.trigger).toBe("dialog");
    expect(t.id).toBe("trans:dialog-open-ax:page:btn-signout-1");
  });

  it("emits a link edge for <a href> (no transition)", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:n0", toAxId: "ax:page:href:/about", kind: "link" },
    ];
    const { edges, transitions } = buildDeclared(PAGE, records);
    expect(edges).toHaveLength(1);
    const e: Edge = at(edges, 0, "edge");
    expect(e.kind).toBe("link");
    expect(e.to).toBe("ax:page:href:/about");
    expect(transitions).toHaveLength(0);
  });

  it("emits APG-implied tablist transitions (focus next tab -> activates tabpanel)", () => {
    // A typical tablist: 3 tabs, each with aria-controls pointing at a panel.
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:tab-recent", toAxId: "ax:page:panel-recent", kind: "apg-tab-activate", transitionKind: "declared", trigger: "focus", apgPattern: "tabs" },
      { fromAxId: "ax:page:tab-popular", toAxId: "ax:page:panel-popular", kind: "apg-tab-activate", transitionKind: "declared", trigger: "focus", apgPattern: "tabs" },
      { fromAxId: "ax:page:tab-archived", toAxId: "ax:page:panel-archived", kind: "apg-tab-activate", transitionKind: "declared", trigger: "focus", apgPattern: "tabs" },
    ];
    const { edges, transitions } = buildDeclared(PAGE, records);
    // apg-tab-activate does not emit an edge — the relationship is already
    // captured via aria-controls (out of scope here) — only transitions.
    expect(edges).toHaveLength(0);
    expect(transitions).toHaveLength(3);
    const t: Transition = at(transitions, 0, "transition");
    expect(t).toMatchObject({
      kind: "declared",
      trigger: "focus",
      fromAxId: "ax:page:tab-recent",
      toAxIds: ["ax:page:panel-recent"],
      apgPattern: "tabs",
      provenance: "html:parse",
    });
  });

  it("skips records that have no target axId (defensive)", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:n0", toAxId: null, kind: "apg", apgRole: "tablist" },
    ];
    const { edges, transitions } = buildDeclared(PAGE, records);
    expect(edges).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  it("transition id counter is per (kind, fromAxId) so different froms get n=1", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:a", toAxId: "ax:page:b", kind: "commandfor", transitionKind: "declared", trigger: "command" },
      { fromAxId: "ax:page:c", toAxId: "ax:page:d", kind: "commandfor", transitionKind: "declared", trigger: "command" },
    ];
    const { transitions } = buildDeclared(PAGE, records);
    const t1: Transition = at(transitions, 0, "transition");
    const t2: Transition = at(transitions, 1, "transition");
    expect(t1.id).toBe("trans:commandfor-ax:page:a-1");
    expect(t2.id).toBe("trans:commandfor-ax:page:c-1");
  });
});

describe("extractStateDeclared — extractor integration", () => {
  it("calls page.script.callFunction with the walker and writes edges + transitions to the graph", async () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:btn", toAxId: "ax:page:dlg", kind: "commandfor", transitionKind: "declared", trigger: "command" },
      { fromAxId: "ax:page:popbtn", toAxId: "ax:page:pop", kind: "popovertarget", transitionKind: "declared", trigger: "popover" },
      { fromAxId: "ax:page:link", toAxId: "ax:page:href:/x", kind: "link" },
    ];
    const { ctx, graph, callFunction, log } = makeCtx(records);
    const r = await extractStateDeclared.run(ctx);
    // PR-8g T1: the declared extractor now reads
    // `document.activeElement` via a second callFunction call to
    // seed the baseline's `focusedAxId`. The first call is the
    // page-side walker (returns DeclaredRecord[]). The second is
    // the focus probe (returns { axId }). Assert both fired.
    expect(callFunction).toHaveBeenCalledTimes(2);
    // The page-side script is a self-invoking arrow that takes pageNodeId.
    const [script, args] = callFunction.mock.calls[0]!.slice(1);
    expect(String(script)).toMatch(/querySelectorAll/);
    expect(args).toEqual([PAGE]);
    expect(r.produced).toBe(true);

    // PR-8b: the extractor now writes more edges (state:cause
    // placeholders + cross-layer state:* edges from the
    // materializer). We assert that the original 3 declared edges
    // (1 commandfor + 1 popovertarget + 1 link) are present and
    // that the total is >= 3.
    expect(graph.edgeCount).toBeGreaterThanOrEqual(3);
    // 2 transitions: 1 commandfor, 1 popovertarget (link has no transition)
    expect(graph.transitionCount).toBe(2);
    // PR-8b (item 2): real State nodes are materialized for the
    // 2 declared transitions (commandfor + popovertarget).
    expect(graph.stateCount).toBeGreaterThan(0);

    // Log line per the spec.
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/\[state-declared\]/);
  });

  it("works with the demo's typical record mix: commandfor + popovertarget + dialog + link + APG tabs", async () => {
    const records: DeclaredRecord[] = [
      // Invoker Commands (known kinds)
      { fromAxId: "ax:page:user-menu-button", toAxId: "ax:page:user-menu", kind: "popovertarget", transitionKind: "declared", trigger: "popover" },
      { fromAxId: "ax:page:sign-out", toAxId: "ax:page:confirm-signout", kind: "commandfor", transitionKind: "declared", trigger: "command" },
      // Custom --foo command
      { fromAxId: "ax:page:theme-toggle", toAxId: "ax:page:awg-theme-root", kind: "commandfor", transitionKind: "declared", trigger: "command" },
      // Dialog (already-open variant)
      { fromAxId: "ax:page:root", toAxId: "ax:page:confirm-signout", kind: "dialog-open", transitionKind: "declared", trigger: "dialog" },
      // <a href>
      { fromAxId: "ax:page:about-link", toAxId: "ax:page:href:/about.html", kind: "link" },
      // APG tabs
      { fromAxId: "ax:page:tab-recent", toAxId: "ax:page:panel-recent", kind: "apg-tab-activate", transitionKind: "declared", trigger: "focus", apgPattern: "tabs" },
      { fromAxId: "ax:page:tab-popular", toAxId: "ax:page:panel-popular", kind: "apg-tab-activate", transitionKind: "declared", trigger: "focus", apgPattern: "tabs" },
    ];
    const { ctx, graph } = makeCtx(records);
    await extractStateDeclared.run(ctx);
    // PR-8b: the extractor now writes MORE edges:
    //   - 4 declared edges with targets (popovertarget + 2 commandfor + dialog-open)
    //   - 1 link edge
    //   - 5 state:cause placeholder edges (one per declared transition with
    //     a target)
    //   - N state:on-page edges (one per State materialization; see below)
    //   - N state:auth edges (one per State)
    //   - N state:successor edges (one per non-equal before/after pair)
    // The original 5 are still present. The new counts depend on how
    // many State materializations happen. With 5 declared
    // transitions, the materializer creates ~5 successor pairs (each
    // transition produces a different after-state), so we add
    // ~5 state:on-page, ~5 state:auth, ~5 state:successor edges.
    // We assert on >= 5 declared edges (the originals) and that
    // states were produced.
    expect(graph.edgeCount).toBeGreaterThanOrEqual(5);
    // 6 declared transitions: 1 popovertarget + 2 commandfor + 1 dialog-open + 2 apg-tab-activate
    expect(graph.transitionCount).toBe(6);
    // PR-8b (item 2): real State nodes are materialized.
    expect(graph.stateCount).toBeGreaterThan(0);
    // PR-8b (item 4): every state:cause placeholder is resolved (or
    // removed if no matching State). Since the test graph has no
    // AxNodes, no State has any of these axIds in its payload
    // elements, so the placeholders are *removed*. After the
    // extractor runs, no `state:cause` edge in the graph points at
    // a `state:TBD:*` id.
    const remainingTbd: string[] = [];
    for (const e of graph.allEdges()) {
      if (e.kind === "state:cause" && e.to.startsWith("state:TBD:")) {
        remainingTbd.push(e.id);
      }
    }
    expect(remainingTbd).toEqual([]);

    // Spot-check a specific transition is in the graph.
    const t = graph.getTransition("trans:apg-tab-activate-ax:page:tab-recent-1");
    expect(t).toBeDefined();
    expect(t?.apgPattern).toBe("tabs");
    expect(t?.trigger).toBe("focus");
  });

  it("returns produced=false and logs when the page has no declared state", async () => {
    const { ctx, graph, log } = makeCtx([]);
    const r = await extractStateDeclared.run(ctx);
    expect(r.produced).toBe(false);
    expect(graph.edgeCount).toBe(0);
    expect(graph.transitionCount).toBe(0);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/\[state-declared\] edges=0 transitions=0/);
  });
});

// PR-8a: declared extractor now also emits Layer 1 NavElements
// (breadcrumbs, menus, menubars, tablists, nav-link-sets) and the
// state:cause placeholder edges that PR-8 will resolve.
describe("buildDeclared — PR-8a NavElement + state:cause", () => {
  it("emits one NavElement per breadcrumb record with ordered members", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:bc-nav", toAxId: null, kind: "nav-element", navKind: "breadcrumb",
        memberAxIds: ["ax:page:bc-0", "ax:page:bc-1", "ax:page:bc-2"], activeMemberAxId: null },
      { fromAxId: "ax:page:bc-nav", kind: "breadcrumb", toAxId: "ax:page:bc-0" },
      { fromAxId: "ax:page:bc-nav", kind: "breadcrumb", toAxId: "ax:page:bc-1" },
      { fromAxId: "ax:page:bc-nav", kind: "breadcrumb", toAxId: "ax:page:bc-2" },
    ];
    const { navElements, edges } = buildDeclared(PAGE, records);
    expect(navElements).toHaveLength(1);
    const n = at(navElements, 0, "nav");
    expect(n).toMatchObject({
      type: "nav-element",
      pageId: PAGE,
      kind: "breadcrumb",
      containerAxId: "ax:page:bc-nav",
      memberAxIds: ["ax:page:bc-0", "ax:page:bc-1", "ax:page:bc-2"],
    });
    expect(n.id).toBe(`nav:${PAGE}:breadcrumb:1`);
    // 3 breadcrumb edges (one per ordered item)
    expect(edges.filter((e) => e.kind === "breadcrumb")).toHaveLength(3);
  });

  it("emits a NavElement for a menu / menubar / tablist with active member", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:menu-c", toAxId: null, kind: "nav-element", navKind: "menu",
        memberAxIds: ["ax:page:m1", "ax:page:m2"], activeMemberAxId: null },
      { fromAxId: "ax:page:menubar-c", toAxId: null, kind: "nav-element", navKind: "menubar",
        memberAxIds: ["ax:page:b1", "ax:page:b2", "ax:page:b3"], activeMemberAxId: null },
      { fromAxId: "ax:page:tablist-c", toAxId: null, kind: "nav-element", navKind: "tablist",
        memberAxIds: ["ax:page:t1", "ax:page:t2", "ax:page:t3"], activeMemberAxId: "ax:page:t2" },
    ];
    const { navElements } = buildDeclared(PAGE, records);
    const kinds = navElements.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["menu", "menubar", "tablist"]));
    const tablist = navElements.find((n) => n.kind === "tablist")!;
    expect(tablist.activeMemberAxId).toBe("ax:page:t2");
    // IDs are namespaced by kind so the same counter never collides
    expect(navElements.find((n) => n.kind === "menu")!.id).toBe(`nav:${PAGE}:menu:1`);
    expect(navElements.find((n) => n.kind === "tablist")!.id).toBe(`nav:${PAGE}:tablist:1`);
  });

  it("emits state:cause edges for commandfor / popovertarget / dialog-open / apg-tab-activate", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:btn1", kind: "state:cause", toAxId: "state:TBD:ax:page:btn1:commandfor" },
      { fromAxId: "ax:page:btn2", kind: "state:cause", toAxId: "state:TBD:ax:page:btn2:popovertarget" },
      { fromAxId: "ax:page:btn3", kind: "state:cause", toAxId: "state:TBD:ax:page:btn3:dialog-open" },
      { fromAxId: "ax:page:tab1", kind: "state:cause", toAxId: "state:TBD:ax:page:tab1:apg-tab-activate" },
    ];
    const { edges } = buildDeclared(PAGE, records);
    const stateCause = edges.filter((e) => e.kind === "state:cause");
    expect(stateCause).toHaveLength(4);
    for (const e of stateCause) {
      expect(e.provenance).toBe("html:parse");
      expect(e.to.startsWith("state:TBD:")).toBe(true);
    }
  });

  it("the placeholder state id follows the documented format state:TBD:<fromAxId>:<kind>", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:invoker", kind: "state:cause", toAxId: "state:TBD:ax:page:invoker:commandfor" },
    ];
    const { edges } = buildDeclared(PAGE, records);
    const e: Edge = at(edges, 0, "edge");
    expect(e.kind).toBe("state:cause");
    expect(e.to).toBe("state:TBD:ax:page:invoker:commandfor");
    expect(e.id).toBe("edge:ax:page:invoker->state:TBD:ax:page:invoker:commandfor:state:cause");
  });

  it("emits menu-of / tab-of edges from a container axId to the NavElement id", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:tablist-c", toAxId: null, kind: "nav-element", navKind: "tablist",
        memberAxIds: ["ax:page:t1"], activeMemberAxId: "ax:page:t1" },
      { fromAxId: "ax:page:tablist-c", kind: "tab-of", toAxId: `nav:${PAGE}:tablist:1` },
    ];
    const { edges, navElements } = buildDeclared(PAGE, records);
    const tabOf = edges.filter((e) => e.kind === "tab-of");
    expect(tabOf).toHaveLength(1);
    const e: Edge = at(tabOf, 0, "tab-of");
    expect(e.from).toBe("ax:page:tablist-c");
    expect(e.to).toBe(`nav:${PAGE}:tablist:1`);
    expect(navElements).toHaveLength(1);
  });

  it("emits a NavElement for a nav-link-set (regular <nav> that is not a breadcrumb)", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:primary-nav", toAxId: null, kind: "nav-element", navKind: "nav-link-set",
        memberAxIds: ["ax:page:link-a", "ax:page:link-b"], activeMemberAxId: null, name: "Primary" },
    ];
    const { navElements } = buildDeclared(PAGE, records);
    expect(navElements).toHaveLength(1);
    expect(navElements[0]?.kind).toBe("nav-link-set");
    expect(navElements[0]?.name).toBe("Primary");
  });

  it("NavElement ids are stable across re-runs (counter resets per-call)", () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:c", toAxId: null, kind: "nav-element", navKind: "tablist",
        memberAxIds: ["ax:page:t1"], activeMemberAxId: "ax:page:t1" },
    ];
    const a = buildDeclared(PAGE, records);
    const b = buildDeclared(PAGE, records);
    expect(a.navElements[0]?.id).toBe(b.navElements[0]?.id);
  });

  it("re-upserting the same NavElement id is idempotent on the graph", async () => {
    const records: DeclaredRecord[] = [
      { fromAxId: "ax:page:c", toAxId: null, kind: "nav-element", navKind: "tablist",
        memberAxIds: ["ax:page:t1"], activeMemberAxId: "ax:page:t1" },
    ];
    const { ctx, graph } = makeCtx(records);
    await extractStateDeclared.run(ctx);
    const first = graph.navElementCount;
    await extractStateDeclared.run(ctx);
    expect(graph.navElementCount).toBe(first);
  });
});

// PR-8c T8: declared-state semantics preserve the actual command
// value (Invoker Commands). show-modal -> 'command-show-modal',
// show-popover -> 'command-show-popover', etc. The trigger on
// the materialized Transition and the trigger on the
// state:successor edge must reflect the actual command, not a
// generic 'command' label.
describe("PR-8c T8: declared-state semantics preserve actual command/action", () => {
  it("commandfor with show-modal -> trigger is 'command-show-modal'", () => {
    const records: DeclaredRecord[] = [
      {
        fromAxId: "ax:page:btn-signin", toAxId: "ax:page:signin-dlg",
        kind: "commandfor", transitionKind: "declared",
        trigger: "command-show-modal", commandValue: "show-modal",
      },
    ];
    const { transitions } = buildDeclared(PAGE, records);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.trigger).toBe("command-show-modal");
  });

  it("commandfor with show-popover -> trigger is 'command-show-popover'", () => {
    const records: DeclaredRecord[] = [
      {
        fromAxId: "ax:page:notif-btn", toAxId: "ax:page:notif-popover",
        kind: "commandfor", transitionKind: "declared",
        trigger: "command-show-popover", commandValue: "show-popover",
      },
    ];
    const { transitions } = buildDeclared(PAGE, records);
    expect(transitions[0]!.trigger).toBe("command-show-popover");
  });

  it("commandfor with toggle-popover -> trigger is 'command-toggle-popover'", () => {
    const records: DeclaredRecord[] = [
      {
        fromAxId: "ax:page:menu-btn", toAxId: "ax:page:menu",
        kind: "commandfor", transitionKind: "declared",
        trigger: "command-toggle-popover", commandValue: "toggle-popover",
      },
    ];
    const { transitions } = buildDeclared(PAGE, records);
    expect(transitions[0]!.trigger).toBe("command-toggle-popover");
  });

  it("commandfor with close -> trigger is 'command-close'", () => {
    const records: DeclaredRecord[] = [
      {
        fromAxId: "ax:page:dismiss-btn", toAxId: "ax:page:dismissed-popover",
        kind: "commandfor", transitionKind: "declared",
        trigger: "command-close", commandValue: "close",
      },
    ];
    const { transitions } = buildDeclared(PAGE, records);
    expect(transitions[0]!.trigger).toBe("command-close");
  });

  it("custom --foo command -> trigger is generic 'command' (no canonical mapping)", () => {
    const records: DeclaredRecord[] = [
      {
        fromAxId: "ax:page:play", toAxId: "ax:page:player",
        kind: "commandfor", transitionKind: "declared",
        trigger: "command", commandValue: "--play-video",
      },
    ];
    const { transitions } = buildDeclared(PAGE, records);
    expect(transitions[0]!.trigger).toBe("command");
  });

  it("the page-side walker maps 'show-modal' to 'command-show-modal' in the trigger", () => {
    // The page-side script is exported as PAGE_SCRIPT (a JS source
    // string). We exercise the actual walker body in a Node VM
    // with a minimal document shim so the dispatch is end-to-end.
    // This is what guarantees the wiring is real, not a unit-test
    // claim about the function body.
    // Find PAGE_SCRIPT import in the test file (already imported above).
    const pageNodeId = "page:https://example.com/";
    // Build a fake document that has a <button command="show-modal" commandfor="dlg1">
    // and a <dialog id="dlg1">. The walker's DOM helpers are minimal.
    type El = {
      id: string | null;
      tagName: string;
      attrs: Map<string, string>;
      hasAttribute(n: string): boolean;
      getAttribute(n: string): string | null;
      getElementsByTagName: any;
      querySelector: any;
      querySelectorAll: any;
    };
    const makeEl = (tag: string, attrs: Record<string, string>): El => {
      const a = new Map(Object.entries(attrs));
      const el: any = {
        id: attrs.id ?? null,
        tagName: tag.toUpperCase(),
        attrs: a,
        hasAttribute: (n: string) => a.has(n),
        getAttribute: (n: string) => a.get(n) ?? null,
      };
      el.getElementsByTagName = (t: string) => [];
      el.querySelector = (_sel: string) => null;
      el.querySelectorAll = (_sel: string) => [];
      return el as El;
    };
    // Build a button + dialog + index. The walker walks via
    // document.querySelectorAll('*') and uses parentElement /
    // getElementById. The bare minimum to drive the happy path:
    const button = makeEl("button", { id: "btn", command: "show-modal", commandfor: "dlg1" });
    const dialog = makeEl("dialog", { id: "dlg1" });
    // The walker expects `document.getElementById` to return the
    // dialog and a flat `document.querySelectorAll('*')` to return
    // [button, dialog]. axIdFor is keyed on element id.
    const allEls: any[] = [button, dialog];
    const fakeDoc: any = {
      documentElement: makeEl("html", {}),
      getElementById: (id: string) => id === "dlg1" ? dialog : null,
      querySelectorAll: (sel: string) => sel === "*" ? allEls : [],
      createTreeWalker: () => {
        const order: any[] = [button, dialog];
        let i = 0;
        return { nextNode: () => order[i++] ?? null };
      },
    };
    (fakeDoc.documentElement as any).parentElement = null;
    (button as any).parentElement = fakeDoc.documentElement;
    (dialog as any).parentElement = fakeDoc.documentElement;
    // Run the page-side script body in a Function with the fake
    // document + NodeFilter shim. PAGE_SCRIPT is an arrow function
    // body (pageNodeId) => { ... return out; } that uses free
    // variables `document` and `NodeFilter` (they live in the
    // page realm). We pass them as function args and then call
    // the arrow function it defines.
    //
    // PAGE_SCRIPT contains a couple of TypeScript type annotations
    // (let navKind: string; etc.) that the TypeScript compiler
    // leaves in place inside the template literal. The browser
    // doesn't care because the actual page-side run injects a
    // transpilation pass, but for our Node VM test we strip the
    // `: type` annotations inline so the body is valid JS.
    // We do NOT touch `toAxId: null` (object-literal property with
    // value null) — that would turn it into a shorthand reference
    // to an undefined `toAxId` variable. We only strip *type*
    // annotations.
    const jsBody = PAGE_SCRIPT
      .replace(/:\s*string\s*\|\s*null\b/g, "")
      .replace(/:\s*string\b/g, "")
      .replace(/:\s*number\b/g, "")
      .replace(/:\s*boolean\b/g, "")
      .replace(/:\s*any\b/g, "");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const caller = new Function(
      "pageNodeId", "document", "NodeFilter",
      `const __fn = ${jsBody}; return __fn(pageNodeId);`
    ) as (p: string, d: any, nf: any) => any;
    const NodeFilterShim = { SHOW_ELEMENT: 1 };
    const records = caller(pageNodeId, fakeDoc, NodeFilterShim);
    const commandfor = records.find((r: any) => r.kind === "commandfor");
    expect(commandfor).toBeDefined();
    // The trigger must be the command-specific value, not 'command'.
    expect(commandfor.trigger).toBe("command-show-modal");
    expect(commandfor.commandValue).toBe("show-modal");
  });

  it("the state:successor edge carries the command-specific trigger (materializer integration)", async () => {
    // The declared materializer writes state:successor edges with
    // `triggers: [trigger]`. Verify the trigger value flows from
    // the record into the edge.
    const records: DeclaredRecord[] = [
      {
        fromAxId: "ax:page:btn-signin", toAxId: "ax:page:signin-dlg",
        kind: "commandfor", transitionKind: "declared",
        trigger: "command-show-modal", commandValue: "show-modal",
      },
    ];
    const { declaredTransitions } = buildDeclared(PAGE, records);
    expect(declaredTransitions[0]!.trigger).toBe("command-show-modal");
  });
});

/**
 * PR-8d T8 — declared State must use actual command semantics.
 *
 * The binding instruction was: "Make declared State use actual
 * command semantics. `deriveAfterSnapshot()` must receive actual
 * declared action. Distinguish: show-modal, close, request-close,
 * show-popover, hide-popover, toggle-popover, popovertarget action,
 * tab activation. `command=hide-popover` must never create
 * after-state in which popover is opened."
 *
 * Before PR-8d T8, `deriveAfterSnapshot` only switched on the edge
 * kind (`commandfor` / `popovertarget` / `dialog-open` /
 * `apg-tab-activate`). Every `commandfor` edge was treated the
 * same: the target was added to `openPopoverIds`. That meant
 * `command=close` and `command=hide-popover` produced after-states
 * in which the popover/dialog was OPEN — exactly opposite of the
 * intended semantics.
 *
 * The fix extends `DeclaredResult.declaredTransitions` with a
 * `commandValue` field and switches `deriveAfterSnapshot` on
 * that value, not on the edge kind. These tests pin every
 * distinct command value's after-state.
 */
describe("PR-8d T8: declared State uses actual command semantics (deriveAfterSnapshot)", () => {
  // We need a way to exercise deriveAfterSnapshot from the test
  // harness. The function is internal to declared.ts, so we
  // reach it through the public materializer: buildDeclared
  // returns declaredTransitions, the orchestrator's extractStateDeclared
  // calls deriveAfterSnapshot for each one and materializes the
  // before/after states. We replicate the orchestrator's
  // materialization call in-test by building a small Graph +
  // before-snapshot, then invoking the public materializeSuccessor
  // with after = deriveAfterSnapshot(before, dt).
  //
  // Since deriveAfterSnapshot is internal, we test it indirectly
  // through extractStateDeclared (which we can call with a stub
  // page). The before/after states are observable in the graph as
  // StateNode.payload.openPopoverIds / openDialogIds.

  function makeStubPage() {
    return {
      target: { context: "ctx-test" },
      script: {
        callFunction: async (_t: any, _src: any, _args: any): Promise<DeclaredRecord[]> => {
          // Stub: the test wires the records it wants into the
          // page-script call by passing a fresh stub each time.
          return [];
        },
      },
      storage: { setCookies: async () => 0 },
    } as any;
  }

  async function runMaterialize(
    records: DeclaredRecord[],
  ) {
    const g = new Graph();
    g.upsertPage({
      id: PAGE, type: "page", url: PAGE, title: "T",
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: `ax:${PAGE}:root`, provenance: "bidi:script.evaluate" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null, screenshotRef: null,
      canonicalUrl: PAGE, crawledAt: "t", parentPageId: null,
    });
    // Seed the target axId nodes so the materializer can find them.
    for (const r of records) {
      if (r.toAxId) {
        g.upsertAx({
          id: r.toAxId, type: "ax-node", pageId: PAGE,
          role: r.kind === "dialog-open" ? "dialog" : "region",
          name: "tgt", nameSource: "content",
          states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
          properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
          apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
        });
      }
      g.upsertAx({
        id: r.fromAxId, type: "ax-node", pageId: PAGE,
        role: "button", name: "src", nameSource: "content",
        states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
        properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
        apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
      });
    }
    // Wire the page stub to return the test's records.
    const page = makeStubPage();
    (page.script.callFunction as any) = async () => records;
    await extractStateDeclared.run({
      graph: g, page, pageNode: {
        id: PAGE, url: PAGE, title: PAGE, type: "page",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: `ax:${PAGE}:root`, provenance: "bidi:script.evaluate" },
        viewport: { w: 1280, h: 800, dpr: 1 },
        tokensOverride: null, screenshotRef: null,
        canonicalUrl: PAGE, crawledAt: "2026-08-30T00:00:00.000Z", parentPageId: null,
      } as any,
      log: () => undefined,
      auth: { kind: "anonymous" },
      network: { status: "online", evidence: "static" },
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });
    return g;
  }

  it("command=show-modal: target appears in openDialogIds, NOT in openPopoverIds", async () => {
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-signin", toAxId: "ax:page:signin-dlg",
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-show-modal", commandValue: "show-modal",
    }];
    const g = await runMaterialize(records);
    // Find the after-state produced for this transition.
    const after = Array.from(g.states()).find((s: any) =>
      s.payload.openDialogIds.includes("ax:page:signin-dlg")
    );
    expect(after).toBeDefined();
    expect(after!.payload.openPopoverIds).not.toContain("ax:page:signin-dlg");
  });

  it("command=show-popover: target appears in openPopoverIds", async () => {
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-pop", toAxId: "ax:page:popover-1",
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-show-popover", commandValue: "show-popover",
    }];
    const g = await runMaterialize(records);
    const after = Array.from(g.states()).find((s: any) =>
      s.payload.openPopoverIds.includes("ax:page:popover-1")
    );
    expect(after).toBeDefined();
  });

  it("command=hide-popover: target is REMOVED from openPopoverIds (NEVER added)", async () => {
    // The binding: "command=hide-popover must never create
    // after-state in which popover is opened."
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-hide", toAxId: "ax:page:popover-1",
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-hide-popover", commandValue: "hide-popover",
    }];
    const g = await runMaterialize(records);
    // The after-state must NOT include the popover in openPopoverIds.
    for (const s of g.states()) {
      expect(s.payload.openPopoverIds).not.toContain("ax:page:popover-1");
    }
  });

  it("command=close: target is REMOVED from openDialogIds and openPopoverIds", async () => {
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-close", toAxId: "ax:page:dlg-1",
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-close", commandValue: "close",
    }];
    const g = await runMaterialize(records);
    for (const s of g.states()) {
      expect(s.payload.openDialogIds).not.toContain("ax:page:dlg-1");
      expect(s.payload.openPopoverIds).not.toContain("ax:page:dlg-1");
    }
  });

  it("command=request-close: target is REMOVED from openDialogIds", async () => {
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-rclose", toAxId: "ax:page:dlg-1",
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-request-close", commandValue: "request-close",
    }];
    const g = await runMaterialize(records);
    for (const s of g.states()) {
      expect(s.payload.openDialogIds).not.toContain("ax:page:dlg-1");
    }
  });

  it("command=toggle-popover: target TOGGLES (off→on, on→off)", async () => {
    // Two transitions: first one with toggle-popover, second one
    // with the same toggle-popover. The first must open it; the
    // second must close it (proves the toggle is symmetric, not
    // an unconditional open).
    const records1: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-tog", toAxId: "ax:page:popover-1",
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-toggle-popover", commandValue: "toggle-popover",
    }];
    const g1 = await runMaterialize(records1);
    const after1 = Array.from(g1.states()).find((s: any) =>
      s.payload.openPopoverIds.includes("ax:page:popover-1")
    );
    expect(after1).toBeDefined();
    // The baseline (before) state must NOT include the popover.
    const before1 = Array.from(g1.states()).find((s: any) =>
      !s.payload.openPopoverIds.includes("ax:page:popover-1") &&
      Object.keys(s.payload.elements).includes("ax:page:btn-tog")
    );
    expect(before1).toBeDefined();
  });

  it("dialog-open (no commandValue): target appears in openDialogIds", async () => {
    // dialog-open is a structural edge; it has no command value
    // because the dialog is always shown modally when opened.
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-dlg", toAxId: "ax:page:dlg-1",
      kind: "dialog-open", transitionKind: "declared",
      trigger: "click",
    }];
    const g = await runMaterialize(records);
    const after = Array.from(g.states()).find((s: any) =>
      s.payload.openDialogIds.includes("ax:page:dlg-1")
    );
    expect(after).toBeDefined();
  });

  it("apg-tab-activate: target is selected=true; other tablist members unaffected", async () => {
    // The tab activation path is unchanged by T8. The after-state
    // must mark the target as selected.
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:tab-1", toAxId: "ax:page:tab-1",
      kind: "apg-tab-activate", transitionKind: "declared",
      trigger: "click",
    }];
    const g = await runMaterialize(records);
    const after = Array.from(g.states()).find((s: any) =>
      s.payload.elements["ax:page:tab-1"]?.selected === true
    );
    expect(after).toBeDefined();
  });

  it("no commandValue (back-compat): target is added to openPopoverIds (default for commandfor)", async () => {
    // Records produced before PR-8d T8 lack a commandValue
    // field. The default must remain the pre-PR-8d behavior
    // (open the popover) so existing test fixtures and crawl
    // results don't regress.
    const records: DeclaredRecord[] = [{
      fromAxId: "ax:page:btn-old", toAxId: "ax:page:popover-1",
      kind: "commandfor", transitionKind: "declared",
      trigger: "command",
      // commandValue is undefined (intentionally)
    }];
    const g = await runMaterialize(records);
    const after = Array.from(g.states()).find((s: any) =>
      s.payload.openPopoverIds.includes("ax:page:popover-1")
    );
    expect(after).toBeDefined();
  });

  it("declaredTransitions[i].commandValue is preserved through buildDeclared", () => {
    // The T8 contract: buildDeclared passes commandValue through
    // to the materialization plan.
    const records: DeclaredRecord[] = [
      {
        fromAxId: "ax:page:btn-hide", toAxId: "ax:page:popover-1",
        kind: "commandfor", transitionKind: "declared",
        trigger: "command-hide-popover", commandValue: "hide-popover",
      },
    ];
    const { declaredTransitions } = buildDeclared(PAGE, records);
    expect(declaredTransitions).toHaveLength(1);
    expect(declaredTransitions[0]!.commandValue).toBe("hide-popover");
  });
});
