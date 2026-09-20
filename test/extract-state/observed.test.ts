/**
 * Unit tests for the observed probe loop (Stage 7.2).
 *
 * No BiDi session required: we drive `runObservedProbeLoop` with injected
 * `listInteractive` + `takeSnapshot` + a recorded `performActions` mock.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runObservedProbeLoop,
  runObservedExtractor,
  observedExtractor,
  snapshotDiffers,
  buildTransitionsForRun,
  MAX_PROBES,
  PROBE_TIMEOUT_MS,
  POST_ACTION_SETTLE_MS,
  EXTENDED_PROBE_ORDER,
  __resetTransitionCounterForTests,
  type ObservedSnapshot,
  type InteractiveElement,
  type ObservedPageLike,
} from "../../src/extract-state/observed.js";
import { Graph } from "../../src/graph/graph.js";

// ---------- Snapshot helpers ----------

function makeSnapshot(over: {
  aria?: Record<string, Record<string, string | null>>;
  dialogOpen?: Record<string, boolean>;
  a11yCount?: number;
  hash?: string;
} = {}): ObservedSnapshot {
  return {
    hash: over.hash ?? "h:base",
    a11yCount: over.a11yCount ?? 0,
    ariaStates: over.aria ?? {},
    dialogOpen: over.dialogOpen ?? {},
  };
}

const PAGE_ID = "page:test";

function makeEl(i: number, over: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    axId: `ax:${PAGE_ID}:n${i}`,
    rect: { x: 100 + i * 20, y: 100, w: 40, h: 20 },
    tagName: over.tagName ?? "button",
    role: over.role ?? "button",
    ...over,
  };
}

// ---------- Page mock builder ----------

interface MockOptions {
  elements: InteractiveElement[];
  /** After which performActions call (1-based) the snapshot should change. */
  diffOnPerform?: number;
  /**
   * PR-8g T1: after which callFunction call (1-based, the focus probe
   * being the typical one) the snapshot should change. Defaults to
   * `diffOnPerform` for backward compat with pre-PR-8g tests that
   * fired the diff on the 1st performActions (= focus path).
   */
  diffOnCall?: number;
  /** The "after" snapshot returned for subsequent takeSnapshot() calls. */
  afterSnapshot?: ObservedSnapshot;
  /** Initial baseline snapshot. */
  baselineSnapshot?: ObservedSnapshot;
}

interface MockPage {
  page: ObservedPageLike;
  performActions: ReturnType<typeof vi.fn>;
  callFunction: ReturnType<typeof vi.fn>;
  performCount: () => number;
  callCount: () => number;
  recordedActions: () => Array<{ context: string; actions: any[] }>;
}

function makeMockPage(opts: MockOptions): MockPage {
  const baseline = opts.baselineSnapshot ?? makeSnapshot({
    hash: "h:baseline",
    a11yCount: opts.elements.length,
    aria: Object.fromEntries(opts.elements.map((e) => [e.axId, {}])),
  });
  const after = opts.afterSnapshot ?? baseline;
  let snapshot = baseline;
  let performCount = 0;
  let callCount = 0;
  // PR-8g T1: `diffOnCall` defaults to `diffOnPerform` so pre-PR-8g
  // tests continue to fire the diff on the first interaction. The
  // focus probe now goes through callFunction (the new V1 path), so
  // tests targeting focus should set `diffOnCall` explicitly to the
  // call number at which the focus probe takes effect.
  const diffOnCall = opts.diffOnCall ?? opts.diffOnPerform;
  const recorded: Array<{ context: string; actions: any[] }> = [];

  const performActions = vi.fn(async (context: string, actions: any[]) => {
    performCount++;
    recorded.push({ context, actions });
    if (opts.diffOnPerform === performCount) snapshot = after;
  });

  // PR-8j T2: V1's runProbe calls `page.input.performActions`
  // directly for keyEnter / keySpace / dismiss (with the
  // readable name translated to the BiDi-spec single code
  // point via `translateKeyName`). The mock's `sendKey` is a
  // no-op — V1 doesn't use it. sendKey is still present on
  // the mock because `ObservedPageLike.input` requires it
  // (the type is `Pick<InputApi, "performActions" | "sendKey">`).

  const callFunction = vi.fn(async (_target: any, _fn: any, _args: any) => {
    callCount++;
    // First call returns the interactive list; subsequent calls return the
    // current snapshot.
    if (callCount === 1) return opts.elements;
    if (diffOnCall === callCount) snapshot = after;
    return snapshot;
  });

  return {
    page: {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: performActions as any, sendKey: vi.fn(async () => undefined) },
    },
    performActions,
    callFunction,
    performCount: () => performCount,
    callCount: () => callCount,
    recordedActions: () => recorded,
  };
}

const NO_WAIT = async () => undefined;
const FROZEN_NOW = () => 0;

// ---------- Tests ----------

describe("snapshotDiffers", () => {
  it("returns false for identical snapshots", () => {
    const a = makeSnapshot({ hash: "h:1", a11yCount: 3 });
    const b = makeSnapshot({ hash: "h:1", a11yCount: 3 });
    expect(snapshotDiffers(a, b)).toBe(false);
  });

  it("returns true when a11yCount differs", () => {
    const a = makeSnapshot({ hash: "h:1", a11yCount: 3 });
    const b = makeSnapshot({ hash: "h:2", a11yCount: 4 });
    expect(snapshotDiffers(a, b)).toBe(true);
  });

  it("returns true when an aria-state value changes", () => {
    const a = makeSnapshot({ hash: "h:1", aria: { "ax:1": { "aria-expanded": "false" } } });
    const b = makeSnapshot({ hash: "h:2", aria: { "ax:1": { "aria-expanded": "true" } } });
    expect(snapshotDiffers(a, b)).toBe(true);
  });

  it("returns true when a dialog open attribute changes", () => {
    const a = makeSnapshot({ hash: "h:1", dialogOpen: { dlg: false } });
    const b = makeSnapshot({ hash: "h:2", dialogOpen: { dlg: true } });
    expect(snapshotDiffers(a, b)).toBe(true);
  });
});

describe("runObservedProbeLoop", () => {
  beforeEach(() => {
    __resetTransitionCounterForTests();
  });

  it("takes the baseline snapshot before any probe is issued", async () => {
    const els = [makeEl(0)];
    const order: string[] = [];
    // Hand-craft the mock so we can track snapshot vs perform order.
    const page: ObservedPageLike = {
      target: { context: "ctx" } as any,
      script: {
        callFunction: vi.fn(async () => {
          // First call: list. Subsequent calls: snapshot.
          if (order.filter((s) => s === "list").length === 0) {
            order.push("list");
            return els;
          }
          order.push("snapshot");
          return makeSnapshot({ hash: "h:base" });
        }) as any,
        evaluate: vi.fn(),
      },
      input: {
        performActions: vi.fn(async () => { order.push("perform"); }) as any,
        sendKey: vi.fn(async () => undefined),
      },
    };
    await runObservedProbeLoop({
      page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    // The first action is the list call, then a snapshot, then perform.
    expect(order[0]).toBe("list");
    const firstPerformIdx = order.indexOf("perform");
    const firstSnapshotIdx = order.indexOf("snapshot");
    expect(firstSnapshotIdx).toBeLessThan(firstPerformIdx);
    expect(firstPerformIdx).toBeGreaterThan(0);
  });

  it("issues focus (real DOM), hover, click, keyEnter, keySpace in documented order when no transition occurs", async () => {
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const mock = makeMockPage({ elements: els });
    const kinds: string[] = [];
    mock.performActions.mockImplementation(async (_ctx: string, actions: any[]) => {
      const a = actions[0];
      if (a.type === "pointer") {
        // PR-8g T1: focus is no longer dispatched as a click-shape
        // pointer sequence. Focus now goes through probeElementLegacy
        // (script.callFunction with el.focus()) and never enters
        // performActions at all. Only hover (move only) and click
        // (move+down+up) reach performActions in the order below.
        kinds.push(a.actions.length === 1 ? "hover" : "click");
      } else if (a.type === "key") {
        const v = a.actions.find((x: any) => x.type === "keyDown")?.value;
        kinds.push("key:" + v);
      }
    });
    let callCount = 0;
    mock.callFunction.mockImplementation(async (_ctx: string, _fn: unknown, _arg: unknown) => {
      callCount++;
      // The 1st callFunction is the listInteractive call (returns els).
      if (callCount === 1) return els;
      // PR-8g T1: subsequent callFunction calls are either the
      // baseline/before/after snapshots (returning { kind: "ok" } here
      // because the test asserts on `kinds`, not snapshot diffs) or
      // the focus probe. The focus probe is the one that takes the
      // [pageId, axId, "focus"] arg shape. We record it as a `focus`
      // kind for the assertion below.
      const isFocus = Array.isArray(_arg) && _arg.length >= 3 && _arg[1] === "ax:" + PAGE_ID + ":n0" && _arg[2] === "focus";
      if (isFocus) kinds.push("focus");
      return { kind: "ok" };
    });
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    // PR-8g T1: documented priority order with the focus-truthfulness
    // fix. Focus is dispatched via script.callFunction(el.focus()),
    // NOT through performActions. Only hover/click/keyboard actions
    // reach performActions.
    expect(kinds).toEqual([
      "focus",     // real DOM focus (script.callFunction, NOT pointer)
      "hover",     // hover (move only)
      "click",     // click (move+down+up)
      // PR-8j T2: the V1 loop now translates the readable key
      // name to the BiDi-spec single code point before
      // issuing keyDown/keyUp. The values are the
      // WebDriver-classic keyboard codes in the U+E000-U+EFFF
      // private-use area (U+E007 = Enter, U+E00C = Escape,
      // 0x20 = Space) — see src/bidi-client/input.ts
      // KEY_NAME_TO_CODE.
      "key:",  // U+E007 (Enter)
      "key: ",   // 0x20 (Space)
    ]);
    expect(kinds).not.toContain("key:Escape");
    expect(kinds).not.toContain("key:Enter");
    expect(kinds).not.toContain("key:Space");
    expect(result.transitions).toBe(0);
    expect(result.probes).toBe(5);
  });

  it("records a transition when an aria-expanded false->true diff is detected", async () => {
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const baseline = makeSnapshot({
      hash: "h:before",
      aria: { [`ax:${PAGE_ID}:n0`]: { "aria-expanded": "false" } },
    });
    const after = makeSnapshot({
      hash: "h:after",
      aria: { [`ax:${PAGE_ID}:n0`]: { "aria-expanded": "true" } },
    });
    // PR-8g T1: focus is now the 4th callFunction call (after list,
    // baseline, before-snapshot). The diff must fire on the focus
    // probe call so the after-snapshot returns the new state.
    const mock = makeMockPage({ elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnCall: 4 });
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    expect(result.transitions).toBe(1);
    expect(result.hits[0]?.probe).toBe("focus");
    expect(result.hits[0]?.beforeHash).toBe("h:before");
    expect(result.hits[0]?.afterHash).toBe("h:after");
  });

  it("records the FIRST probe that produced a transition (focus); subsequent probes on the same element do not double-count", async () => {
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const baseline = makeSnapshot({
      hash: "h:before",
      aria: { [`ax:${PAGE_ID}:n0`]: { "aria-expanded": "false" } },
    });
    const after = makeSnapshot({
      hash: "h:after",
      aria: { [`ax:${PAGE_ID}:n0`]: { "aria-expanded": "true" } },
    });
    // PR-8g T1: the focus probe is the 4th callFunction call. After
    // focus produces a hit, hover/click/keyEnter/keySpace probes
    // continue to run (per-(element, probe-kind) gate) but their
    // before/after snapshots are both `after`, so no further hit
    // is recorded. The pre-PR-8g version skipped all subsequent
    // probes — that was the bug being fixed.
    const mock = makeMockPage({ elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnCall: 4 });
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    expect(result.transitions).toBe(1);
    expect(result.hits[0]?.probe).toBe("focus");
    // PR-8g T1: hover, click, keyEnter, keySpace all still run on
    // the same element after focus hits (they were not skipped).
    // Dismiss also runs because focus produced a transition on
    // this element (probeApplies gates dismiss on
    // elementHadDiff.has(axId)). The pre-PR-8g gate would have
    // stopped at performCount=1; the post-PR-8g gate keeps the
    // documented 5-probe sequence (hover, click, keyEnter,
    // keySpace, dismiss).
    expect(mock.performCount()).toBe(5);
  });

  it("respects the 30-probe cap", async () => {
    // 31 elements, each gets a focus probe; no transition is ever produced.
    const els = Array.from({ length: 31 }, (_, i) => makeEl(i, { role: "button", tagName: "button" }));
    const mock = makeMockPage({ elements: els });
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    expect(result.probes).toBe(MAX_PROBES);
    // PR-8g T1: each element gets 1 callFunction probe (focus) and
    // 4 performActions probes (hover, click, keyEnter, keySpace).
    // dismiss never fires because no transition was produced.
    // 6 elements × 4 performActions = 24. The remaining 6 probes
    // toward MAX_PROBES=30 are the 6 focus callFunction calls.
    expect(mock.performCount()).toBe(24);
  });

  it("captures dialog open attribute changes", async () => {
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const baseline = makeSnapshot({
      hash: "h:before",
      dialogOpen: { dlg: false },
    });
    const after = makeSnapshot({
      hash: "h:after",
      dialogOpen: { dlg: true },
    });
    const mock = makeMockPage({ elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnPerform: 1 });
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    expect(result.transitions).toBe(1);
    const transitions = buildTransitionsForRun(result, PAGE_ID);
    expect(transitions[0]?.beforeSnapshot).toBe("snapshot:h:before");
    expect(transitions[0]?.afterSnapshot).toBe("snapshot:h:after");
    expect(transitions[0]?.kind).toBe("observed");
    expect(transitions[0]?.provenance).toBe("dom-diff:probe");
  });

  it("aborts the loop when the 5-second budget is exceeded", async () => {
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const mock = makeMockPage({ elements: els });
    let t = 0;
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: () => (t += 10_000),
    });
    // Now jumps straight past the 5s budget on the first call, so the
    // loop should bail before running any probe.
    expect(result.probes).toBe(0);
    expect(mock.performCount()).toBe(0);
  });

  it("emits Transition records with the documented shape", async () => {
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const baseline = makeSnapshot({
      hash: "h:before",
      aria: { [`ax:${PAGE_ID}:n0`]: { "aria-expanded": "false" } },
    });
    const after = makeSnapshot({
      hash: "h:after",
      aria: { [`ax:${PAGE_ID}:n0`]: { "aria-expanded": "true" } },
    });
    // PR-8g T1: focus is now the 4th callFunction call. The
    // transition's trigger must be `focus` (not `click`) because
    // the focus probe is the truthful DOM-level event.
    const mock = makeMockPage({ elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnCall: 4 });
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    const ts = buildTransitionsForRun(result, PAGE_ID);
    expect(ts).toHaveLength(1);
    const t = ts[0]!;
    expect(t.kind).toBe("observed");
    expect(t.trigger).toBe("focus");
    expect(t.fromAxId).toBe(`ax:${PAGE_ID}:n0`);
    expect(t.toAxIds).toEqual([]);
    expect(t.beforeSnapshot).toBe("snapshot:h:before");
    expect(t.afterSnapshot).toBe("snapshot:h:after");
    expect(t.apgPattern).toBeNull();
    expect(t.preconditions).toEqual([]);
    expect(t.provenance).toBe("dom-diff:probe");
  });

  it("skips click/keyboard probes on non-button roles", async () => {
    // A non-interactive role: focus and hover apply, but click and the
    // keyboard activation probes do not.
    const els = [makeEl(0, { role: "presentation", tagName: "div" })];
    const mock = makeMockPage({ elements: els });
    const kinds: string[] = [];
    mock.performActions.mockImplementation(async (_ctx: string, actions: any[]) => {
      const a = actions[0];
      if (a.type === "pointer") {
        kinds.push(a.actions.length === 1 ? "hover" : "click");
      } else if (a.type === "key") {
        const v = a.actions.find((x: any) => x.type === "keyDown")?.value;
        kinds.push("key:" + v);
      }
    });
    let callCount = 0;
    mock.callFunction.mockImplementation(async (_ctx: string, _fn: unknown, _arg: unknown) => {
      callCount++;
      // 1st callFunction is the listInteractive call (returns els).
      if (callCount === 1) return els;
      // The focus probe is the callFunction call that takes
      // [pageId, axId, "focus"] args. Other callFunction calls
      // (baseline, before/after snapshots) take [pageId] and
      // should NOT be recorded as focus.
      const isFocus = Array.isArray(_arg) && _arg.length >= 3 && typeof _arg[1] === "string" && _arg[1].startsWith("ax:") && _arg[2] === "focus";
      if (isFocus) kinds.push("focus");
      return { kind: "ok" };
    });
    const result = await runObservedProbeLoop({
      page: mock.page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    // PR-8g T1: focus is real DOM (callFunction); hover is the only
    // pointer dispatch. No click, no keyEnter/keySpace.
    expect(kinds).toEqual(["focus", "hover"]);
    expect(result.probes).toBe(2);
  });
});

describe("runObservedExtractor (wires into Graph)", () => {
  beforeEach(() => {
    __resetTransitionCounterForTests();
  });

  it("writes observed transitions into the graph and logs the one-line summary", async () => {
    // PR-8: runObservedExtractor now uses the V2 probe loop, which expects
    // a RichSnapshot shape ({elements[], openDialogIds, ...}) on every
    // callFunction call after the list call. Construct V2 mock shapes
    // here so the loop's takeRichSnapshot returns a valid baseline + a
    // valid "after" snapshot that differs.
    const el = makeEl(0, { role: "button", tagName: "button" });
    const baselineSnap = {
      hash: "h:before",
      elements: [{
        axId: el.axId,
        rect: el.rect,
        visibility: "visible" as const,
        zIndex: 0,
        open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
        ariaStates: { "aria-expanded": "false" },
        visualNodeId: null,
      }],
      openDialogIds: [],
      openPopoverIds: [],
      expandedRegionAxIds: [],
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      online: true,
      conditionalMarkers: {},
    };
    const afterSnap = {
      ...baselineSnap,
      hash: "h:after",
      elements: [{
        ...baselineSnap.elements[0]!,
        pressed: true, // button is now pressed; richSnapshotDiffers will see this
      }],
    };
    let callIndex = 0;
    const callFunction = vi.fn(async (_target: any, _fn: any) => {
      callIndex++;
      // Order of callFunction calls from the V2 orchestrator:
      //   1) runObservedExtractor's pre-baseline takeRichSnapshot → SNAPSHOT
      //   2) V2 loop's listInteractive → LIST
      //   3) V2 loop's baseline takeSnapshot → SNAPSHOT
      //   4) probe-before takeSnapshot → SNAPSHOT
      //   5) probe-after takeSnapshot → SNAPSHOT
      if (callIndex === 2) return [el];
      if (callIndex <= 4) return baselineSnap;
      return afterSnap;
    });
    const performActions = vi.fn(async () => undefined);
    const page: ObservedPageLike = {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: performActions as any, sendKey: vi.fn(async () => undefined) },
    };
    const graph = new Graph();
    const log = vi.fn();
    const r = await runObservedExtractor(graph, page, PAGE_ID, log);
    expect(r.produced).toBe(true);
    expect(graph.transitionCount).toBe(1);
    // PR-8g T1: per-(element, probe-kind) bookkeeping means the loop
    // runs all applicable probes on the single element even after
    // focus hits. We assert the dynamic count (>=1 hit) and that
    // there is exactly one transition in the graph.
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\s*\[state-observed\] probes=\d+ hits=1 states=\d+$/));
  });

  // ------------------------------------------------------------------
  // PR-8 mandatory acceptance test (T10, T11):
  //   "After PR-8 materializes the State graph, there must be zero
  //    edges in the graph whose `to` starts with `state:TBD:`."
  // This is the binding end-to-end Layer 1 -> Layer 4 integration
  // check. The placeholder targets were written in PR-8a T5 as
  // forward references; PR-8's resolveStateCauseEdges() is the
  // only thing that can rewrite them.
  // ------------------------------------------------------------------
  it("resolves every state:cause placeholder (no dangling state:TBD: edges)", async () => {
    const axId = `ax:${PAGE_ID}:n0`;
    const el = makeEl(0, { role: "button", tagName: "button" });
    const baselineSnap = {
      hash: "h:before",
      elements: [{
        axId: el.axId,
        rect: el.rect,
        visibility: "visible" as const,
        zIndex: 0,
        open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
        ariaStates: { "aria-expanded": "false" },
        visualNodeId: null,
      }],
      openDialogIds: [],
      openPopoverIds: [],
      expandedRegionAxIds: [],
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      online: true,
      conditionalMarkers: {},
    };
    const afterSnap = {
      ...baselineSnap,
      hash: "h:after",
      elements: [{ ...baselineSnap.elements[0]!, pressed: true }],
    };
    let callIndex = 0;
    const callFunction = vi.fn(async () => {
      callIndex++;
      if (callIndex === 2) return [el];
      if (callIndex <= 4) return baselineSnap;
      return afterSnap;
    });
    const page: ObservedPageLike = {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    const graph = new Graph();
    // Seed the AxNode so resolveStateCauseEdges can map the source
    // axId back to a page (item 4: the resolver looks up
    // graph.getAx(sourceAxId).pageId).
    graph.upsertAx({
      id: axId,
      type: "ax-node",
      pageId: PAGE_ID,
      role: "button",
      name: "btn",
      nameSource: "aria-label",
      states: {
        expanded: null, disabled: null, pressed: null,
        selected: null, checked: null, busy: null, open: null, current: null,
      },
      properties: {
        controls: [], describedBy: [], labelledBy: [],
        level: null, live: null, orientation: null,
        posInSet: null, setSize: null,
        valueNow: null, valueMin: null, valueMax: null, valueText: null,
      },
      apgPattern: null,
      focusable: true, visibility: "visible", inPageDomOrder: 0,
      parentAxId: null,
      provenance: "bidi:script.evaluate",
    });
    // Seed the state:cause placeholder edge the same way PR-8a T5
    // emits it: from = axId, to = "state:TBD:<fromAxId>:<kind>".
    graph.upsertEdge({
      id: `edge:${axId}->state:TBD:${axId}:click:state:cause`,
      type: "edge", kind: "state:cause",
      from: axId, to: `state:TBD:${axId}:click`,
      provenance: "html:parse",
    });
    await runObservedExtractor(graph, page, PAGE_ID, vi.fn());

    // Binding invariant: no edge in the graph has a `to` starting
    // with `state:TBD:`. A regression of resolveStateCauseEdges()
    // would surface here.
    for (const e of graph.allEdges()) {
      expect(e.to.startsWith("state:TBD:")).toBe(false);
    }
    // The placeholder edge's `to` was rewritten to a real
    // state:<sha256> id.
    const rewritten = [...graph.allEdges()].find(
      (e) => e.kind === "state:cause" && e.from === axId,
    );
    expect(rewritten).toBeDefined();
    expect(rewritten!.to.startsWith("state:")).toBe(true);
    expect(rewritten!.to.startsWith("state:TBD:")).toBe(false);
    // A State node was upserted.
    expect(graph.stateCount).toBeGreaterThan(0);
  });

  // PR-8b item 4: when the source axId is not in the graph (no
  // pageId can be resolved), the placeholder is REMOVED, not
  // re-pointed at a random state. The orchestrator surfaces this
  // through the [state-cause-unresolved] log line.
  it("removes state:cause placeholders when the source axId has no pageId in the graph", async () => {
    const axId = `ax:${PAGE_ID}:orphan`;
    const el = makeEl(0, { role: "button", tagName: "button" });
    el.axId = axId;
    const baselineSnap = {
      hash: "h:before",
      elements: [{
        axId,
        rect: el.rect,
        visibility: "visible" as const,
        zIndex: 0,
        open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
        ariaStates: { "aria-expanded": "false" },
        visualNodeId: null,
      }],
      openDialogIds: [],
      openPopoverIds: [],
      expandedRegionAxIds: [],
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      online: true,
      conditionalMarkers: {},
    };
    let callIndex = 0;
    const callFunction = vi.fn(async () => {
      callIndex++;
      if (callIndex === 2) return [el];
      return baselineSnap;
    });
    const page: ObservedPageLike = {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    const graph = new Graph();
    // Seed the placeholder. Note: no AxNode is upserted, so
    // graph.getAx(axId) is undefined and the resolver cannot find
    // a pageId.
    graph.upsertEdge({
      id: `edge:${axId}->state:TBD:${axId}:click:state:cause`,
      type: "edge", kind: "state:cause",
      from: axId, to: `state:TBD:${axId}:click`,
      provenance: "html:parse",
    });
    const log = vi.fn();
    await runObservedExtractor(graph, page, PAGE_ID, log);

    // The placeholder was removed (NOT re-pointed).
    const remaining = [...graph.allEdges()].find(
      (e) => e.kind === "state:cause" && e.from === axId,
    );
    expect(remaining).toBeUndefined();
    // No edge in the graph points at state:TBD:*.
    for (const e of graph.allEdges()) {
      expect(e.to.startsWith("state:TBD:")).toBe(false);
    }
  });
});

describe("PR-8d (item 2): visualNodeId is passed through, not blanked", () => {
  /**
   * `richToMaterializeSnapshot` must NOT overwrite the page-side
   * observation's `visualNodeId` with null. The page-side
   * `RICH_SNAPSHOT_FN` mints a `vis:<pageId>:<axId>` placeholder
   * for every element with a visual node; the Node-side
   * materializer resolves the placeholder against the graph's
   * visual layer (`graph.getVisual(obs.visualNodeId)`). If the
   * converter blanked the value, every state observation would
   * lose its visual link — the bug PR-8c T2 set out to fix,
   * silently regressed by the PR-8c-era `visualNodeId: null`
   * hardcode. This test guards the regression.
   */
  it("richToMaterializeSnapshot passes visualNodeId from RichElementObservation to MaterializeSnapshot", async () => {
    // Synthetic rich snapshot with a non-null visualNodeId.
    const el = {
      axId: "ax:user-menu",
      rect: { x: 0, y: 0, w: 100, h: 50 },
      visibility: "visible" as const,
      zIndex: 1,
      open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
      // PR-8g T1: per-element focus flag.
      focused: false,
      ariaStates: { "aria-haspopup": "menu" },
      visualNodeId: "vis:page:test:ax:user-menu", // real page-side placeholder
      conditionalMarkers: {},
    };
    const before = {
      hash: "h:before",
      elements: [el],
      openDialogIds: [], openPopoverIds: [], expandedRegionAxIds: [],
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      online: true,
      conditionalMarkers: {},
      // PR-8g T1: State-level focus pointer. Default: no element
      // focused.
      focusedAxId: null,
    };
    const after = {
      ...before,
      hash: "h:after",
      elements: [{ ...el, pressed: true }],
    };
    const interactive: InteractiveElement[] = [{
      axId: el.axId,
      tagName: "button",
      role: "button",
      rect: el.rect,
    }];
    let callIndex = 0;
    const callFunction = vi.fn(async (_target: any, _fn: any) => {
      callIndex++;
      // Call ordering under runObservedExtractor:
      //   1) takeRichSnapshot pre-baseline → SNAPSHOT
      //   2) listInteractiveElements → LIST
      //   3) takeRichSnapshot baseline → SNAPSHOT
      //   4) takeRichSnapshot probe-before → SNAPSHOT
      //   5) takeRichSnapshot probe-after → SNAPSHOT
      if (callIndex === 1) return before;
      if (callIndex === 2) return interactive;
      if (callIndex === 3) return before;
      if (callIndex === 4) return before;
      return after;
    });
    const page: ObservedPageLike = {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined) as any, sendKey: vi.fn(async () => undefined) },
    };
    const graph = new Graph();
    await runObservedExtractor(graph, page, PAGE_ID, vi.fn());
    // The state materializer is invoked. The visualNodeId on the
    // source axId's state observation must be the page-side
    // placeholder (or whatever the resolver found), NOT null.
    // We assert at the graph level: the State that was produced
    // for the after-snapshot should have a visualNodeId-bearing
    // element observation.
    const states = Array.from(graph.states());
    expect(states.length).toBeGreaterThan(0);
    const someState = states.find(s => s.payload.elements[el.axId]);
    expect(someState).toBeDefined();
    // The point of this test: the observation's visualNodeId is
    // NOT null after the conversion. (The materializer may later
    // look up the real VisualNode id; but the value the page-side
    // script provided must be retained, not blanked.)
    expect(someState!.payload.elements[el.axId]!.visualNodeId).toBe(
      "vis:page:test:ax:user-menu",
    );
  });
});

describe("observedExtractor plug-in", () => {
  it("has the name 'state-observed' and an async run()", () => {
    expect(observedExtractor.name).toBe("state-observed");
    expect(typeof observedExtractor.run).toBe("function");
  });
});

describe("constants", () => {
  it("MAX_PROBES is 30", () => { expect(MAX_PROBES).toBe(30); });
  it("PROBE_TIMEOUT_MS is 5000", () => { expect(PROBE_TIMEOUT_MS).toBe(5_000); });
  it("POST_ACTION_SETTLE_MS is 300", () => { expect(POST_ACTION_SETTLE_MS).toBe(300); });
});

/**
 * PR-8 2C/2D: the observed extractor records the auth and network
 * contexts passed via the `opts` argument on every State it
 * materializes. The default remains anonymous + static when no opts
 * are passed.
 */
describe("runObservedExtractor — auth + network context propagation (PR-8 2C/2D)", () => {
  beforeEach(() => {
    __resetTransitionCounterForTests();
  });

  function v2PageMock(opts: { baselineAfter?: any; withDiff?: boolean } = {}) {
    const baseline = {
      hash: "h:base",
      elements: [{
        axId: "ax:test:n0", rect: { x: 0, y: 0, w: 1, h: 1 },
        visibility: "visible" as const, zIndex: 0,
        open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
        // PR-8g T1: per-element focus flag.
        focused: false,
        ariaStates: {}, visualNodeId: null,
      }],
      openDialogIds: [], openPopoverIds: [], expandedRegionAxIds: [],
      viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
      online: true, conditionalMarkers: {},
      // PR-8g T1: State-level focus pointer.
      focusedAxId: null,
    };
    const after = opts.withDiff ? { ...baseline, hash: "h:after", elements: [{ ...baseline.elements[0]!, pressed: true }] } : baseline;
    const el = { axId: "ax:test:n0", rect: { x: 0, y: 0, w: 1, h: 1 }, tagName: "button", role: "button" };
    let callIndex = 0;
    const callFunction = vi.fn(async () => {
      callIndex++;
      if (callIndex === 2) return [el];
      if (callIndex <= 4) return baseline;
      return after;
    });
    const page = {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined) as any, sendKey: vi.fn(async () => undefined) },
    };
    return { page, graph: new Graph() };
  }

  it("defaults to anonymous + static when no opts are passed", async () => {
    const { page, graph } = v2PageMock({ withDiff: true });
    await runObservedExtractor(graph, page, "page:test", () => undefined);
    // The materialized State should have anonymous + static.
    const states = [...graph.states()];
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(s.authContext).toEqual({ kind: "anonymous" });
      expect(s.networkContext.evidence).toBe("static");
    }
  });

  it("propagates the auth context passed via opts", async () => {
    const { page, graph } = v2PageMock({ withDiff: true });
    await runObservedExtractor(graph, page, "page:test", () => undefined, {
      auth: { kind: "administrator", principal: "bob", session: "s1" },
    });
    const states = [...graph.states()];
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(s.authContext).toEqual({ kind: "administrator", principal: "bob", session: "s1" });
    }
  });

  it("propagates the network context passed via opts (page-instrumented)", async () => {
    const { page, graph } = v2PageMock({ withDiff: true });
    await runObservedExtractor(graph, page, "page:test", () => undefined, {
      network: { status: "online", evidence: "page-instrumented" },
    });
    const states = [...graph.states()];
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(s.networkContext.evidence).toBe("page-instrumented");
    }
  });

  it("propagates bidi:network evidence when the shim is wired", async () => {
    const { page, graph } = v2PageMock({ withDiff: true });
    await runObservedExtractor(graph, page, "page:test", () => undefined, {
      network: { status: "online", evidence: "bidi:network" },
    });
    const states = [...graph.states()];
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(s.networkContext.evidence).toBe("bidi:network");
    }
  });
});

/**
 * PR-8d T3: The per-probe interaction vocabulary must be a real,
 * named probe per direction. The old shape had a single generic
 * "keyArrow" probe that was being remapped to ArrowDown, which
 * lost the actual trigger label on the resulting
 * `state:successor` edge. PR-8d splits the direction keys into
 * independent probes and adds separate `scroll` and
 * `network-wait` page-level probes.
 */
describe("PR-8d T3: per-probe interaction vocabulary (directional + page-level)", () => {
  it("EXTENDED_PROBE_ORDER has each direction as its own probe kind (no single keyArrow)", () => {
    for (const k of [
      "keyArrowUp",
      "keyArrowDown",
      "keyArrowLeft",
      "keyArrowRight",
      "keyHome",
      "keyEnd",
      "keyTab",
      "keyEnter",
      "keySpace",
      "keyEscape",
    ]) {
      expect(EXTENDED_PROBE_ORDER, `must include ${k}`).toContain(k);
    }
    // The old generic "keyArrow" must not exist.
    expect(EXTENDED_PROBE_ORDER, "must not contain the generic 'keyArrow' probe").not.toContain(
      "keyArrow",
    );
  });

  it("EXTENDED_PROBE_ORDER includes page-level scroll + network-wait", () => {
    expect(EXTENDED_PROBE_ORDER).toContain("scroll");
    expect(EXTENDED_PROBE_ORDER).toContain("network-wait");
  });

  it("EXTENDED_PROBE_ORDER keeps all PR-8c-era probes (no regression in coverage)", () => {
    for (const k of [
      "click",
      "focus",
      "hover",
      "type",
      "submit",
      "expand",
      "collapse",
      "dialog-open",
      "dialog-close",
      "tab-activate",
      "drag",
    ]) {
      expect(EXTENDED_PROBE_ORDER, `must include ${k}`).toContain(k);
    }
  });

  // PR-8e (Blocker 4): the 'conditional' probe was removed because no
  // truthful non-cooperative action semantics exist. The substrate
  // captures conditional state via the rich snapshot's
  // conditionalMarkers field, not via a fabricated DOM mutation. This
  // negative-assertion test pins the removal so a regression that
  // re-adds 'conditional' to the probe order fails the gate.
  it("PR-8e Blocker 4: 'conditional' is NOT a probe kind (markers are captured via rich snapshot diff)", () => {
    expect(EXTENDED_PROBE_ORDER, "conditional was removed in PR-8e").not.toContain("conditional");
  });
});

/**
 * PR-8d T4: PROBE_ELEMENT_FN must NOT fabricate state by
 * rewriting ARIA attributes directly. Real application state
 * changes come from dispatching the user-event the element is
 * bound to (MouseEvent/KeyboardEvent/CustomEvent). The page-
 * side function is static-checked here because we cannot run a
 * full BiDi realm in a unit test.
 *
 * The runtime counterpart to this static check is in
 * `test/extract-state/probe-element.test.ts`, which actually
 * executes PROBE_ELEMENT_FN against a minimal fake document.
 */
describe("PR-8d T4: PROBE_ELEMENT_FN does not fabricate state (event-dispatch contract)", () => {
  it("dispatches a real MouseEvent for expand/collapse (not setAttribute aria-expanded)", async () => {
    const { PROBE_ELEMENT_FN } = await import("../../src/extract-state/observed.js");
    expect(PROBE_ELEMENT_FN).toMatch(/new MouseEvent\('click'/);
    expect(PROBE_ELEMENT_FN, "must not directly set aria-expanded").not.toMatch(
      /setAttribute\(['"]aria-expanded['"]/,
    );
  });

  it("dispatches a real KeyboardEvent for tab-activate (not setAttribute aria-selected)", async () => {
    const { PROBE_ELEMENT_FN } = await import("../../src/extract-state/observed.js");
    expect(PROBE_ELEMENT_FN).toMatch(/new KeyboardEvent\(['"]keydown['"]/);
    expect(PROBE_ELEMENT_FN, "must not directly set aria-selected").not.toMatch(
      /setAttribute\(['"]aria-selected['"]/,
    );
  });

  // PR-8e (Blocker 1 + Blocker 4): the 'conditional' probe kind was
  // REMOVED from production because no truthful non-cooperative action
  // semantics exist. The substrate captures conditional state via the
  // rich snapshot's conditionalMarkers field; the page is the
  // authority for that state. This test is now a negative assertion:
  // the production code must not dispatch awg:condition-change
  // CustomEvents, must not directly toggle data-condition-* attributes,
  // and must not read data-condition-* to fabricate state.
  it("PR-8e Blocker 1+4: no awg:condition-change event, no fabricated data-condition-* mutation", async () => {
    const { PROBE_ELEMENT_FN } = await import("../../src/extract-state/observed.js");
    expect(
      PROBE_ELEMENT_FN,
      "PR-8e removed the awg:condition-change CustomEvent; conditional state is captured via the rich snapshot diff",
    ).not.toMatch(/new CustomEvent\(['"]awg:condition-change/);
    expect(
      PROBE_ELEMENT_FN,
      "PR-8e forbids direct data-condition-* attribute mutation as a probe action",
    ).not.toMatch(/setAttribute\(['"]data-condition-/);
    expect(
      PROBE_ELEMENT_FN,
      "PR-8e forbids reading data-condition-* to fabricate state in the probe path",
    ).not.toMatch(/getAttribute\(['"]data-condition-/);
  });

  it("uses the native showModal()/close() user-API for dialogs (the only allowed direct-mutation path)", async () => {
    const { PROBE_ELEMENT_FN } = await import("../../src/extract-state/observed.js");
    expect(PROBE_ELEMENT_FN).toMatch(/\.showModal\(/);
    expect(PROBE_ELEMENT_FN).toMatch(/\.close\(/);
  });

  it("returns a discriminator result so the loop can decide ok/noop/missing", async () => {
    const { PROBE_ELEMENT_FN } = await import("../../src/extract-state/observed.js");
    expect(PROBE_ELEMENT_FN).toMatch(/return \{ kind: ['"]ok['"]/);
    expect(PROBE_ELEMENT_FN).toMatch(/return \{ kind: ['"]noop['"]/);
    expect(PROBE_ELEMENT_FN).toMatch(/return \{ kind: ['"]missing['"]/);
  });
});

/**
 * PR-8d T3 (cont): The trigger label on a `state:successor` edge
 * is the *real* probe kind. The old code mapped every directional
 * arrow probe to "keyArrowDown" — a generic substitution. PR-8d
 * splits the directions so the recorded label is the actual key.
 * We assert the mapping in the source for the directional keys,
 * the page-level probes, and the discriminated non-arrow keys
 * (Enter/Space/Escape/Tab).
 */
describe("PR-8d T3: trigger label on state:successor edges is the real probe kind", () => {
  it("maps each direction to its own trigger label (not a single keyArrowDown fallback)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/extract-state/observed.ts", "utf8"),
    );
    const cases: Array<[string, string]> = [
      ["keyArrowUp", '"key-arrow-up"'],
      ["keyArrowDown", '"key-arrow-down"'],
      ["keyArrowLeft", '"key-arrow-left"'],
      ["keyArrowRight", '"key-arrow-right"'],
      ["keyHome", '"key-home"'],
      ["keyEnd", '"key-end"'],
      ["keyTab", '"key-tab"'],
      ["keyEnter", '"key-enter"'],
      ["keySpace", '"key-space"'],
      ["keyEscape", '"key-escape"'],
    ];
    for (const [probe, want] of cases) {
      // Each direction must map to a literal trigger string in the
      // source. We look for the case clause in `extendedProbeToTrigger`.
      const re = new RegExp(`case\\s+["']${probe}["']\\s*:\\s*return\\s+${want}`);
      expect(src, `${probe} must map to ${want}`).toMatch(re);
    }
  });

  it("page-level scroll and network-wait map to their own trigger labels", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/extract-state/observed.ts", "utf8"),
    );
    expect(src).toMatch(/case\s+["']scroll["']\s*:\s*return\s+"scroll"/);
    expect(src).toMatch(/case\s+["']network-wait["']\s*:\s*return\s+"network-wait"/);
  });
});


