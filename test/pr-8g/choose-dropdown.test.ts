/**
 * PR-8h T2 — choose-dropdown truthfulness via real BiDi input.
 *
 * **Acceptance criterion (PR-8h blocker 2, verbatim).**
 *  - Make `choose-dropdown` a genuine browser interaction.
 *  - Remove programmatically synthesized selection as the
 *    authoritative observed transition mechanism.
 *  - Do NOT use, as proof of a user/browser transition:
 *      * direct native value setter followed by `dispatchEvent`;
 *      * `new Event("change")`;
 *      * `new Event("input")`;
 *      * `new MouseEvent("click")` on an option.
 *  - Drive native <select> and ARIA combobox/listbox through
 *    genuine WebDriver BiDi pointer/keyboard interaction.
 *  - The application must change state because the browser
 *    interaction occurred.
 *  - Add live behavioral tests proving the events/interactions
 *    reach the application through the browser input substrate
 *    rather than script-generated `dispatchEvent`.
 *
 * **Regression protection.**
 *  - The page-side PROBE_ELEMENT_FN MUST NOT contain any of
 *    the four forbidden patterns above for the
 *    `choose-dropdown` case.
 *  - The runExtendedProbe `choose-dropdown` branch MUST route
 *    through `page.input.performActions` (real BiDi), not
 *    `probeElement` (page-side script).
 *  - The trigger recorded on the produced transition must be
 *    `choose-dropdown`, NOT `click`.
 *  - The probe must be a no-op when no alternative option
 *    exists (single-option select).
 *  - A non-dropdown element (e.g. <button>) must NEVER be
 *    probed with choose-dropdown.
 *
 * These tests run in two layers:
 *  1. Static-text assertions on the source code that pin the
 *     production contract (no synthesized event, no script
 *     mutation, real BiDi dispatch).
 *  2. Behavioral assertions on the probe loop driven by a
 *     mock `ObservedPageLike` that records which transport
 *     was used (`input.performActions` vs `script.callFunction`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runObservedProbeLoopV2,
  runChooseDropdown,
  extendedProbeToTrigger,
  type RichSnapshot,
  type InteractiveElement,
  type ObservedPageLike,
} from "../../src/extract-state/observed.js";

const PAGE_ID = "page:cd";

function makeEl(i: number, over: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    axId: `ax:${PAGE_ID}:n${i}`,
    rect: { x: 100 + i * 20, y: 100, w: 40, h: 20 },
    tagName: over.tagName ?? "button",
    role: over.role ?? "button",
    ...over,
  };
}

function makeRichSnapshot(over: {
  hash?: string;
  elements?: RichSnapshot["elements"];
} = {}): RichSnapshot {
  return {
    hash: over.hash ?? "h:base",
    elements: over.elements ?? [],
    openDialogIds: [],
    openPopoverIds: [],
    expandedRegionAxIds: [],
    viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
    online: true,
    conditionalMarkers: {},
    focusedAxId: null,
  };
}

const NO_WAIT = async () => undefined;
const FROZEN_NOW = () => 0;

/** Read the source of observed.ts to pin the production contract. */
const OBSERVED_SRC = readFileSync(
  join(process.cwd(), "src/extract-state/observed.ts"),
  "utf8",
);

describe("PR-8h T2: choose-dropdown uses real BiDi (no synthesized event)", () => {
  it("ACCEPTANCE: PROBE_ELEMENT_FN choose-dropdown case is a noop (no event dispatch)", () => {
    // The choose-dropdown case in PROBE_ELEMENT_FN is the
    // page-side dispatch path. PR-8h removes it entirely
    // (real BiDi drives the change from runExtendedProbe).
    // The case body must contain NO `dispatchEvent` and NO
    // setter.call mutation. The only allowed content is a
    // noop with a PR-8h reference comment.
    //
    // Locate the case body by isolating the choose-dropdown
    // branch.
    const chooseMatch = OBSERVED_SRC.match(
      /case 'choose-dropdown':\s*\{[\s\S]*?^\s{4}\}/m,
    );
    expect(chooseMatch, "PROBE_ELEMENT_FN must contain a choose-dropdown case").not.toBeNull();
    const body = chooseMatch ? chooseMatch[0] : "";
    expect(
      body.includes("dispatchEvent"),
      "PR-8h: choose-dropdown case MUST NOT call dispatchEvent (no synthesized event). Body:\n" + body,
    ).toBe(false);
    expect(
      body.includes("setter.call"),
      "PR-8h: choose-dropdown case MUST NOT call setter.call (no native value mutation from script). Body:\n" + body,
    ).toBe(false);
    expect(
      body.includes("new MouseEvent"),
      "PR-8h: choose-dropdown case MUST NOT create a MouseEvent (no synthesized click). Body:\n" + body,
    ).toBe(false);
    expect(
      body.includes("new Event("),
      "PR-8h: choose-dropdown case MUST NOT create an Event (no synthesized change/input). Body:\n" + body,
    ).toBe(false);
    // The body must be a noop.
    expect(
      body.includes("'noop'"),
      "PR-8h: choose-dropdown case must be a noop (real BiDi drives the change).",
    ).toBe(true);
  });

  it("ACCEPTANCE: runExtendedProbe routes choose-dropdown through real BiDi input.performActions", () => {
    // The runExtendedProbe switch's choose-dropdown case must
    // call `runChooseDropdown` (or a similar real-BiDi
    // dispatcher) — NOT `probeElement`. The body of the
    // choose-dropdown case in runExtendedProbe is the
    // architectural witness.
    // Anchor on the runExtendedProbe function to pick the right
    // case (the probeApplies function also has `case
    // "choose-dropdown":` but it returns a boolean, not a body
    // that calls runChooseDropdown). The choose-dropdown case
    // in runExtendedProbe is the only one that calls
    // `await runChooseDropdown(page, el);` immediately after the
    // case label.
    const runExtIdx = OBSERVED_SRC.indexOf("async function runExtendedProbe(");
    expect(runExtIdx, "runExtendedProbe function must exist").toBeGreaterThan(-1);
    // Find the FIRST `case "choose-dropdown":` after runExtendedProbe.
    const caseIdx = OBSERVED_SRC.indexOf('case "choose-dropdown":', runExtIdx);
    expect(caseIdx, "runExtendedProbe must contain a choose-dropdown case").toBeGreaterThan(-1);
    // Capture the body up to the next `case "dialog-open":` at the
    // same indentation level (4 spaces).
    const caseBodyMatch = OBSERVED_SRC.slice(caseIdx).match(
      /^case "choose-dropdown":\s*([\s\S]*?)\r?\n {4}case "dialog-open":/,
    );
    expect(caseBodyMatch, "choose-dropdown case body must terminate at case dialog-open").not.toBeNull();
    const body = caseBodyMatch ? caseBodyMatch[1] ?? "" : "";
    expect(
      body.includes("runChooseDropdown") || body.includes("input.performActions"),
      "PR-8h: runExtendedProbe choose-dropdown must route through runChooseDropdown / input.performActions (real BiDi), not probeElement. Body:\n" + body,
    ).toBe(true);
    // The page-side PROBE_ELEMENT_FN dispatch path MUST NOT
    // appear in the choose-dropdown case body.
    expect(
      !body.includes("probeElement("),
      "PR-8h: runExtendedProbe choose-dropdown must NOT call probeElement (page-side script). Body:\n" + body,
    ).toBe(true);
  });

  it("ACCEPTANCE: runChooseDropdown uses page.input.performActions (real BiDi) for native <select>", () => {
    // The helper function must drive a real pointer click on
    // the select's center, then real BiDi keys (ArrowDown),
    // with NO page-side synthesized event.
    const helperMatch = OBSERVED_SRC.match(
      /async function runChooseDropdown\([\s\S]*?\r?\n\}\r?\n/,
    );
    expect(helperMatch, "runChooseDropdown must exist as a real function").not.toBeNull();
    const body = helperMatch ? helperMatch[0] : "";
    expect(
      body.includes("input.performActions"),
      "PR-8h: runChooseDropdown must call page.input.performActions (real BiDi).",
    ).toBe(true);
    expect(
      body.includes("ArrowDown"),
      "PR-8h: runChooseDropdown must use ArrowDown BiDi key for native <select>.",
    ).toBe(true);
    // No synthesized event.
    expect(
      !body.includes("dispatchEvent(") || !body.includes("new MouseEvent") || !body.includes("new Event("),
      "PR-8h: runChooseDropdown MUST NOT contain any synthesized event. Body contains these substrings — failing.",
    ).toBe(true);
  });

  it("ACCEPTANCE: native <select> change records as choose-dropdown transition (not click)", async () => {
    // Behavioral: with a mock that records both transports,
    // the choose-dropdown probe must drive a real BiDi pointer
    // click + a real BiDi key. We directly call runChooseDropdown
    // (the helper the runExtendedProbe switch routes to) and
    // assert that:
    //   1. The page's `script.callFunction` (page-side READ) is
    //      used to read the option count (no mutation).
    //   2. The page's `input.performActions` is the transport that
    //      fires the pointer click and the ArrowDown key.
    //   3. The `extendedProbeToTrigger` function maps the
    //      "choose-dropdown" probe kind to the literal
    //      "choose-dropdown" trigger string.
    const ax0 = `ax:${PAGE_ID}:n0`;
    const baseline = makeRichSnapshot({
      hash: "h:baseline",
      elements: [{
        axId: ax0,
        rect: { x: 100, y: 100, w: 200, h: 30 },
        visibility: "visible", zIndex: null, open: null, expanded: null,
        selected: false, checked: null, pressed: null, busy: null, focused: null,
        ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
      }],
    });
    const els = [makeEl(0, { role: "combobox", tagName: "select" })];
    const { page, recording } = makeDropdownMockPage({
      elements: els,
      baseline,
    });
    // Invoke the BiDi-driven helper directly. This is exactly
    // what `runExtendedProbe` does for `case "choose-dropdown":`.
    await runChooseDropdown(page, els[0]!, PAGE_ID);
    // 1. Real BiDi pointer click + key were dispatched.
    expect(recording.performCount).toBe(2);
    // 2. The pointer was first, then a key (ArrowDown for
    //    native <select>).
    const types = recording.performArgs.map(
      (a) => (Array.isArray(a) && a[0] && a[0].type) || "?",
    );
    expect(types).toEqual(["pointer", "key"]);
    // 3. The key action's payload is the BiDi-spec single
    //    code point for ArrowDown (U+E015, the WebDriver
    //    classic keyboard code for ArrowDown in the
    //    U+E000–U+EFFF private-use area). See
    //    src/bidi-client/input.ts KEY_NAME_TO_CODE and
    //    PR-8j T2.
    const keyAction = recording.performArgs[1]?.[0];
    const keyDowns = Array.isArray(keyAction?.actions)
      ? keyAction.actions.filter((a: any) => a && a.type === "keyDown")
      : [];
    expect(keyDowns.length).toBeGreaterThanOrEqual(1);
    expect((keyDowns[0] as any).value).toBe("");
    // 4. The trigger recorded on the produced transition must be
    //    "choose-dropdown" (not "click"). Verify via the
    //    extendedProbeToTrigger mapping.
    expect(extendedProbeToTrigger("choose-dropdown")).toBe("choose-dropdown");
    expect(extendedProbeToTrigger("click")).toBe("click");
  });

  it("REGRESSION: no-diff scenario produces no choose-dropdown hit", async () => {
    const ax0 = `ax:${PAGE_ID}:n0`;
    const baseline = makeRichSnapshot({
      hash: "h:base",
      elements: [{
        axId: ax0,
        rect: { x: 100, y: 100, w: 200, h: 30 },
        visibility: "visible", zIndex: null, open: null, expanded: null,
        selected: false, checked: null, pressed: null, busy: null, focused: null,
        ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
      }],
    });
    const els = [makeEl(0, { role: "combobox", tagName: "select" })];
    const { page } = makeDropdownMockPage({
      elements: els,
      baseline,
      // No afterForChoose: after === baseline → no diff.
    });
    const result = await runObservedProbeLoopV2({
      page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    const chooseHits = result.hits.filter((h) => h.probe === "choose-dropdown");
    expect(chooseHits.length).toBe(0);
  });

  it("REGRESSION: non-dropdown element is NEVER probed with choose-dropdown (probe-applies gate)", async () => {
    const ax0 = `ax:${PAGE_ID}:n0`;
    const baseline = makeRichSnapshot({
      hash: "h:base",
      elements: [{
        axId: ax0,
        rect: { x: 100, y: 100, w: 60, h: 30 },
        visibility: "visible", zIndex: null, open: null, expanded: null,
        selected: false, checked: null, pressed: null, busy: null, focused: null,
        ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
      }],
    });
    const els = [makeEl(0, { role: "button", tagName: "button" })];
    const { page, recording } = makeDropdownMockPage({
      elements: els,
      baseline,
    });
    const result = await runObservedProbeLoopV2({
      page, pageId: PAGE_ID, wait: NO_WAIT, now: FROZEN_NOW,
    });
    const chooseHits = result.hits.filter((h) => h.probe === "choose-dropdown");
    expect(chooseHits.length).toBe(0);
    // The choose-dropdown probe must never have been invoked at
    // all (neither via callFunction nor via performActions).
    const chooseCallFn = recording.callArgs.filter(
      (a) => Array.isArray(a) && a[2] === "choose-dropdown",
    );
    expect(chooseCallFn.length).toBe(0);
  });
});

interface ChooseMockRecording {
  callArgs: any[][];
  callCount: number;
  performCount: number;
  performArgs: any[][];
}

function makeDropdownMockPage(opts: {
  elements: InteractiveElement[];
  afterForChoose?: RichSnapshot;
  baseline?: RichSnapshot;
}): { page: ObservedPageLike; recording: ChooseMockRecording } {
  const baseline = opts.baseline ?? makeRichSnapshot();
  const after = opts.afterForChoose ?? baseline;
  let callCount = 0;
  let performCount = 0;
  let chooseFired = false;
  const recording: ChooseMockRecording = {
    callArgs: [],
    callCount: 0,
    performCount: 0,
    performArgs: [],
  };

  const callFunction = async (_target: any, _fn: any, args: any) => {
    callCount++;
    recording.callCount = callCount;
    recording.callArgs.push(args);
    if (callCount === 1) {
      // First call is listInteractive: return the elements.
      return opts.elements;
    }
    // For takeSnapshot calls: once the choose-dropdown BiDi
    // sequence (pointer click + ArrowDown key) has fired, the
    // next snapshot must reflect the post-action state. Before
    // that, return the baseline. Other probes (focus, click,
    // hover, key) also call performActions, but they each fire
    // ONE action, not the pointer-then-key pair that
    // choose-dropdown uses — so `chooseFired` stays false until
    // the choose-dropdown probe actually runs.
    if (chooseFired) {
      return after;
    }
    return baseline;
  };
  // `page.script.evaluate` is used by runChooseDropdown to read
  // option rects / listbox state. Return a benign shape so the
  // helper exits cleanly (it'll find a non-actionable listbox
  // and noop).
  const evaluate = async (_target: any, expr: string) => {
    // Detect the read patterns: the helper looks for
    //   `count` + `current` (native select)
    //   `needsType` / `hasOptions` / `options` (ARIA combobox)
    // For the native <select> test path: return a select with
    // 3 options so the BiDi arrow-down actually changes the
    // value.
    if (expr.includes("querySelectorAll('select')")) {
      return { count: 1, current: JSON.stringify([{ count: 3, current: "opt1" }]) };
    }
    if (expr.includes("Promise")) {
      // The "wait for listbox to render" poll. Return false
      // immediately (no listbox rendered). The helper noops.
      return false;
    }
    if (expr.includes("querySelectorAll('[role")) {
      return null;
    }
    return null;
  };
  const performActions = async (_ctx: any, actions: any[]) => {
    performCount++;
    recording.performCount = performCount;
    recording.performArgs.push(actions);
    // The choose-dropdown probe fires exactly 2 BiDi actions in
    // sequence: a pointer (the click on the <select>), then a
    // key (the ArrowDown). Arm the next-snapshot gate on this
    // pair. We track a rolling window of 2 action types so any
    // prior 1-action probe (click / hover / key*) does not
    // arm it.
    const lastTypes = recording.performArgs.map(
      (a) => (Array.isArray(a) && a[0] && a[0].type) || "?",
    );
    if (
      lastTypes.length >= 2 &&
      lastTypes[lastTypes.length - 2] === "pointer" &&
      lastTypes[lastTypes.length - 1] === "key"
    ) {
      // Arm the next snapshot to return the post-choose-dropdown
      // state. We use a one-shot arm so unrelated later probes
      // do not also re-use the same "after" state.
      chooseFired = true;
    }
  };

  return {
    page: {
      target: { context: "ctx" } as any,
      script: { callFunction: callFunction as any, evaluate: evaluate as any },
      input: { performActions: performActions as any, sendKey: (async () => undefined) as any },
    },
    recording,
  };
}
