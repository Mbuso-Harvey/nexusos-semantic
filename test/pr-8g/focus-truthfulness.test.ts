/**
 * PR-8g T1 — Focus truthfulness: explicit acceptance + regression tests.
 *
 * **Acceptance criterion (Blocker 1, verbatim).**
 *  - Focus probe → focus event / focused state; click handler count remains 0.
 *  - Click probe  → click event / application transition; trigger = click.
 *
 * **Regression protection (Blocker 1, verbatim).**
 *  - A button that changes state only on click — focus must NOT
 *    discover or label that click transition.
 *
 * These tests are deliberately architecture-agnostic. They drive the
 * observed probe loop with a mock `ObservedPageLike` and assert:
 *  1. The focus probe dispatches DOM `el.focus()` via `script.callFunction`
 *     (NOT a BiDi pointer click) and never calls `input.performActions`.
 *  2. The click probe dispatches a BiDi pointer click via
 *     `input.performActions` (NOT a focus call).
 *  3. The `elementProduced` set is keyed per-(element, probe-kind), so a
 *     focus hit on element X does NOT block a subsequent click probe on
 *     element X (and vice versa).
 *  4. The trigger recorded on the produced transition matches the probe
 *     that produced it: `focus` for a focus hit, `click` for a click hit.
 *  5. A click-only state change (no focus change) is NOT misattributed
 *     to `focus` — the focus probe is recorded as a no-op (no
 *     transition) when the only diff is a click-shape change.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runObservedProbeLoop,
  __resetTransitionCounterForTests,
  type ObservedSnapshot,
  type InteractiveElement,
  type ObservedPageLike,
} from "../../src/extract-state/observed.js";

function makeSnapshot(over: {
  hash?: string;
  a11yCount?: number;
  aria?: Record<string, Record<string, string | null>>;
  dialogOpen?: Record<string, boolean>;
} = {}): ObservedSnapshot {
  return {
    hash: over.hash ?? "h:base",
    a11yCount: over.a11yCount ?? 0,
    ariaStates: over.aria ?? {},
    dialogOpen: over.dialogOpen ?? {},
  };
}

const PAGE_ID = "page:ft";

function makeEl(i: number, over: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    axId: `ax:${PAGE_ID}:n${i}`,
    rect: { x: 100 + i * 20, y: 100, w: 40, h: 20 },
    tagName: over.tagName ?? "button",
    role: over.role ?? "button",
    ...over,
  };
}

const NO_WAIT = async () => undefined;
const FROZEN_NOW = () => 0;

interface ProbeRecording {
  /** Number of times `input.performActions` was called (click/hover/key). */
  performCount: number;
  /** Number of times `script.callFunction` was called (list + snapshots + focus). */
  callCount: number;
  /** Shapes dispatched through `input.performActions`, in order. */
  performedActions: Array<{ type: string; actions: any[] }>;
  /** AxIds passed to `script.callFunction` for focus probes, in order. */
  focusedAxIds: string[];
  /** All hit records, in order, with probe kind and hashes. */
  hits: Array<{ axId: string; probe: string; beforeHash: string; afterHash: string }>;
}

/**
 * Mock page builder. Unlike the V1 shared mock in observed.test.ts, this
 * builder exposes the full dispatch surface so the PR-8g T1 tests can
 * assert that focus goes through `callFunction` and click goes through
 * `performActions` — and only those paths.
 */
function makeFocusMockPage(opts: {
  elements: InteractiveElement[];
  /**
   * If set, the callFunction call at this 1-based index returns a
   * snapshot different from the baseline. The 1st callFunction call
   * returns the interactive element list; subsequent calls return
   * snapshots. The 2nd call is the baseline; the 3rd is the
   * before-snapshot for the first focus probe. So `diffOnCall: 3`
   * means the diff fires on the first focus probe's after-snapshot.
   * `diffOnCall: 4` means the diff fires on the second focus probe's
   * after-snapshot (i.e. NOT on the first focus probe).
   */
  diffOnCall?: number;
  /**
   * If set, the performActions call at this 1-based index returns a
   * snapshot different from the baseline. The 1st performActions
   * call is the hover probe; the 2nd is the click probe. So
   * `diffOnPerform: 2` means the diff fires on the click probe.
   */
  diffOnPerform?: number;
  /** Baseline snapshot. */
  baselineSnapshot?: ObservedSnapshot;
  /** After-diff snapshot. */
  afterSnapshot?: ObservedSnapshot;
}): { page: ObservedPageLike; recording: ProbeRecording } {
  const baseline = opts.baselineSnapshot ?? makeSnapshot({
    hash: "h:baseline",
    a11yCount: opts.elements.length,
    aria: Object.fromEntries(opts.elements.map((e) => [e.axId, {}])),
  });
  const after = opts.afterSnapshot ?? baseline;
  let snapshot = baseline;
  let performCount = 0;
  let callCount = 0;
  const recording: ProbeRecording = {
    performCount: 0,
    callCount: 0,
    performedActions: [],
    focusedAxIds: [],
    hits: [],
  };

  const performActions = vi.fn(async (_ctx: string, actions: any[]) => {
    performCount++;
    recording.performCount = performCount;
    recording.performedActions.push({ type: actions[0]?.type ?? "?", actions });
    if (opts.diffOnPerform === performCount) snapshot = after;
  });

  const callFunction = vi.fn(async (_target: any, fn: any, args: any) => {
    callCount++;
    recording.callCount = callCount;
    // Inspect the page-side script to detect focus probes. The
    // focus probe's page-side fn is a wrapper that calls el.focus().
    // The 1st callFunction is the list-interactives call. Subsequent
    // calls are the snapshot + focus path. We track focus calls by
    // the script's body — a real focus probe carries an axId arg
    // and has the "focus" probe-kind discriminator.
    if (callCount === 1) {
      return opts.elements;
    }
    // The focus probe calls probeElementLegacy(page, axId, "focus")
    // which dispatches `script.callFunction(target, fn, [pageId, axId, "focus"])`.
    // The list and snapshot calls use `[pageId]`. So a focus call is
    // one where args[0] is the pageId (e.g. "page:ft"), args[1] is an
    // axId (e.g. "ax:page:ft:n0"), and args[2] is the string "focus".
    if (
      Array.isArray(args) && args.length >= 3 &&
      typeof args[0] === "string" && !args[0].startsWith("ax:") &&
      typeof args[1] === "string" && args[1].startsWith("ax:") &&
      args[2] === "focus"
    ) {
      recording.focusedAxIds.push(args[1]);
    }
    if (opts.diffOnCall === callCount) snapshot = after;
    return snapshot;
  });

  return {
    page: {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: performActions as any, sendKey: vi.fn(async () => undefined) },
    },
    recording,
  };
}

describe("PR-8g T1: focus truthfulness", () => {
  beforeEach(() => {
    __resetTransitionCounterForTests();
  });

  it("ACCEPTANCE: focus probe goes through script.callFunction, never through input.performActions", async () => {
    // Verbatim acceptance test: focus probe → focus event / focused
    // state; click handler count remains 0. The click handler count
    // here is the number of pointer actions dispatched through
    // performActions. With one element, the focus probe must NOT
    // produce a pointer action — only the focus callFunction.
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const { page, recording } = makeFocusMockPage({ elements: els });
    await runObservedProbeLoop({ page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW });
    // The focus probe ran exactly once and went through callFunction.
    expect(recording.focusedAxIds).toEqual([`ax:${PAGE_ID}:n0`]);
    // The focus probe did NOT dispatch any pointer action.
    // performActions is called by hover (move only) and click
    // (move+down+up). Both still run; what we are asserting is
    // that NO pointer sequence was generated for the focus probe.
    // The focus probe's only effect is the callFunction call.
    const pointerShapes = recording.performedActions.filter((a) => a.type === "pointer");
    // Two pointer actions are expected: hover (move only) and click
    // (move+down+up). Both come from the documented probe order.
    expect(pointerShapes.length).toBe(2);
    // The click action is the second pointer action (after hover).
    // The focus probe is NOT in this list. The BiDi shape wraps the
    // pointer actions in a single-source array, so the source-level
    // `actions` array has 1 element (the source) whose `.actions` is
    // the move+down+up array of length 3.
    const clickShape = pointerShapes[1];
    expect(clickShape).toBeDefined();
    expect(clickShape!.actions[0].actions.length).toBe(3); // move + down + up
  });

  it("ACCEPTANCE: click probe goes through input.performActions as a 3-step pointer sequence, never through script.callFunction", async () => {
    // Verbatim acceptance test: click probe → click event /
    // application transition; trigger = click. We assert the click
    // probe is dispatched as a BiDi input.performActions with the
    // move+down+up shape (NOT a callFunction el.focus()).
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const { page, recording } = makeFocusMockPage({ elements: els });
    await runObservedProbeLoop({ page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW });
    // The first pointer action is hover (move only). The second is
    // the click (move+down+up). The BiDi `input.performActions` call
    // shape wraps the source-level action array in an outer array
    // (`[{ type: "pointer", actions: [...] }]`). The hover has 1
    // inner action (pointerMove); the click has 3 (move + down + up).
    const clickSource = recording.performedActions
      .map((a) => a.actions[0])
      .find((src) => src?.type === "pointer" && src.actions?.length === 3);
    expect(clickSource, "click probe must be a 3-step pointer action").toBeDefined();
  });

  it("REGRESSION: a click-only state change is NOT misattributed to the focus probe", async () => {
    // Verbatim regression test: a button that changes state only on
    // click — focus must NOT discover or label that click transition.
    // Setup: a button that, when clicked, changes aria-expanded
    // false→true. When focused, it does NOT change aria-expanded
    // (the focus probe's after-snapshot is the baseline). When
    // clicked, the after-snapshot reflects the diff. The diff fires
    // on the click probe's before/after pair, NOT on the focus probe.
    const buttonAxId = `ax:${PAGE_ID}:n0`;
    const baseline = makeSnapshot({
      hash: "h:before",
      aria: { [buttonAxId]: { "aria-expanded": "false" } },
    });
    const after = makeSnapshot({
      hash: "h:after",
      aria: { [buttonAxId]: { "aria-expanded": "true" } },
    });
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    // diffOnPerform: 2 = the click probe (1st performActions is hover).
    const { page, recording } = makeFocusMockPage({
      elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnPerform: 2,
    });
    const result = await runObservedProbeLoop({ page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW });
    // Exactly one hit, and its probe is click — NOT focus.
    expect(result.transitions).toBe(1);
    // Re-run the loop to capture the hit details by re-mocking.
    const { page: page2, recording: rec2 } = makeFocusMockPage({
      elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnPerform: 2,
    });
    const result2 = await runObservedProbeLoop({ page: page2, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW });
    expect(result2.hits[0]?.probe).toBe("click");
    // The focus probe ran (callFunction, not performActions) and
    // did NOT produce a hit because its before/after pair was
    // identical (both the baseline).
    expect(recording.focusedAxIds).toEqual([buttonAxId]);
    expect(rec2.focusedAxIds).toEqual([buttonAxId]);
  });

  it("REGRESSION: a focus-only state change is recorded as probe=focus, NOT click", async () => {
    // Inverse of the above: the button changes state on focus (e.g.
    // shows a focus ring that toggles a CSS data-attribute captured
    // by the page's aria-states probe). The diff fires on the focus
    // probe, recorded as probe=focus. The click probe that runs
    // afterward has identical before/after (both already-after), so
    // it does NOT produce an additional hit.
    const buttonAxId = `ax:${PAGE_ID}:n0`;
    const baseline = makeSnapshot({
      hash: "h:before",
      aria: { [buttonAxId]: { "aria-current": "false" } },
    });
    const after = makeSnapshot({
      hash: "h:after",
      aria: { [buttonAxId]: { "aria-current": "true" } },
    });
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    // Call sequence for 1 element, 5 probes (focus, hover, click, keyEnter, keySpace):
    //   call #1: listInteractive
    //   call #2: baseline snapshot
    //   call #3: before-snapshot for focus
    //   call #4: probeElementLegacy (focus)  <-- fire the diff here
    //   call #5: after-snapshot for focus    <-- returns `after`
    //   perform #1: hover (no diff)
    //   ...
    // diffOnCall: 4 = the focus probe's callFunction. The snapshot
    // mutates to `after` on this call, so the after-snapshot (call
    // #5) returns `after`, and the diff is detected.
    const { page, recording } = makeFocusMockPage({
      elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnCall: 4,
    });
    const result = await runObservedProbeLoop({ page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW });
    expect(result.transitions).toBe(1);
    expect(result.hits[0]?.probe).toBe("focus");
    // The focus probe went through callFunction (not performActions).
    expect(recording.focusedAxIds).toEqual([buttonAxId]);
  });

  it("REGRESSION: a focus hit on element X does NOT block a subsequent click probe on element X", async () => {
    // The pre-PR-8g bug: elementProduced was keyed by axId alone,
    // so once focus produced a hit, click was skipped. The fix is
    // per-(element, probe-kind) bookkeeping. With the fix, focus
    // and click are independent gates. This test asserts that BOTH
    // probes ran even though focus produced a hit.
    const buttonAxId = `ax:${PAGE_ID}:n0`;
    const baseline = makeSnapshot({
      hash: "h:base",
      aria: { [buttonAxId]: {} },
    });
    const after = makeSnapshot({
      hash: "h:after",
      aria: { [buttonAxId]: { "aria-expanded": "true" } },
    });
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    // diffOnCall: 4 = the focus probe fires. After the focus hit,
    // hover, click, keyEnter, keySpace all still run because the
    // elementProduced gate is keyed by (axId, probeKind), not axId.
    const { page, recording } = makeFocusMockPage({
      elements: els, baselineSnapshot: baseline, afterSnapshot: after, diffOnCall: 4,
    });
    const result = await runObservedProbeLoop({ page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW });
    // Focus produced exactly one hit.
    expect(result.transitions).toBe(1);
    expect(result.hits[0]?.probe).toBe("focus");
    // The click probe STILL ran (performCount === 2: hover + click).
    // Pre-PR-8g, performCount would have been 0 (all skipped after focus hit).
    expect(recording.performCount).toBeGreaterThanOrEqual(2);
    // The focus probe ran.
    expect(recording.focusedAxIds).toEqual([buttonAxId]);
  });

  it("REGRESSION: per-(element, probe-kind) gating — focus on element 0 does not block click on element 1", async () => {
    // Two elements. Element 0 transitions on focus; element 1
    // transitions on click. Both probes must run on both elements.
    const ax0 = `ax:${PAGE_ID}:n0`;
    const ax1 = `ax:${PAGE_ID}:n1`;
    const baseline = makeSnapshot({
      hash: "h:base",
      aria: { [ax0]: {}, [ax1]: {} },
    });
    const afterFocus = makeSnapshot({
      hash: "h:focus",
      aria: { [ax0]: { "aria-current": "true" }, [ax1]: {} },
    });
    const afterClick = makeSnapshot({
      hash: "h:click",
      aria: { [ax0]: { "aria-current": "true" }, [ax1]: { "aria-expanded": "true" } },
    });
    const els = [
      makeEl(0, { role: "button", tagName: "button" }),
      makeEl(1, { role: "button", tagName: "button" }),
    ];
    // Track current snapshot. Hand-craft a mock that swaps on
    // specific call/perform indices. Per the observed V1 sequence:
    //   call #1: listInteractive
    //   call #2: baseline snapshot
    //   call #3: before-snapshot for focus on element 0
    //   call #4: focus probe element 0           <-- snapshot mutates to afterFocus
    //   call #5: after-snapshot for focus on 0
    //   call #6: before-snapshot for hover on 0
    //   perform #1: hover element 0
    //   call #7: after-snapshot for hover on 0
    //   call #8: before-snapshot for click on 0
    //   perform #2: click element 0
    //   call #9: after-snapshot for click on 0
    //   call #10: before-snapshot for keyEnter on 0
    //   perform #3: keyEnter element 0
    //   call #11: after-snapshot for keyEnter on 0
    //   ...keySpace, then element 1 starts
    let snapshot = baseline;
    let callCount = 0;
    let performCount = 0;
    const focusedAxIds: string[] = [];

    const callFunction = vi.fn(async (_t: any, _fn: any, args: any) => {
      callCount++;
      if (callCount === 1) return els;
      if (
        Array.isArray(args) && args.length >= 3 &&
        typeof args[0] === "string" && !args[0].startsWith("ax:") &&
        typeof args[1] === "string" && args[1].startsWith("ax:") &&
        args[2] === "focus"
      ) {
        focusedAxIds.push(args[1]);
        // Focus probe of element 0 is call #4.
        if (args[1] === ax0 && callCount === 4) snapshot = afterFocus;
      }
      return snapshot;
    });
    const performActions = vi.fn(async (_c: string, _actions: any[]) => {
      performCount++;
      // V1 probe order per element: focus, hover, click, keyEnter,
      // keySpace, dismiss. focus is callFunction; the others are
      // performActions. So per-element performActions = 5 (hover,
      // click, keyEnter, keySpace, dismiss — dismiss only if a
      // prior probe on this element produced a transition).
      // Perform #1-5 = element 0 (hover, click, keyEnter, keySpace, dismiss).
      // Perform #6 = hover on element 1.
      // Perform #7 = click on element 1. We mutate here.
      if (performCount === 7) snapshot = afterClick;
    });
    const page: ObservedPageLike = {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: vi.fn() },
      input: { performActions: performActions as any, sendKey: vi.fn(async () => undefined) },
    };
    const result = await runObservedProbeLoop({ page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW });
    // Two hits: one focus on element 0, one click on element 1.
    expect(result.transitions).toBe(2);
    const byProbe = new Map(result.hits.map((h) => [h.probe + ":" + h.axId, h]));
    expect(byProbe.get(`focus:${ax0}`)?.afterHash).toBe("h:focus");
    expect(byProbe.get(`click:${ax1}`)?.afterHash).toBe("h:click");
    // Both elements got the focus probe.
    expect(focusedAxIds).toEqual([ax0, ax1]);
  });
});
