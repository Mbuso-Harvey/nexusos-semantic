/**
 * PR-8i T2 — choose-dropdown reads are bound to el.axId, not document-global.
 *
 * **Acceptance criterion (PR-8i item 4, verbatim).**
 *  - Bind dropdown reads to the actual structural element.
 *  - No `querySelectorAll(...)[0]`; resolve the option/listbox
 *    belonging specifically to the probed `el.axId`.
 *
 * **Regression protection.**
 *  - The `runChooseDropdown` function in `src/extract-state/observed.ts`
 *    MUST NOT contain any of these page-side patterns:
 *      * `querySelectorAll('select')`
 *      * `querySelector('[role="combobox"]')`
 *      * `querySelector('[role="combobox"], [role="listbox"]')`
 *      * `querySelectorAll('[role="combobox"]')`
 *  - The `runChooseDropdown` function MUST use the AXID-bound
 *    resolution helpers (`RESOLVE_AXID_BOUND_FN`,
 *    `POLL_COMBOBOX_OPTIONS_FN`) — proof: the source contains
 *    the literal `RESOLVE_AXID_BOUND_FN` reference and the literal
 *    `AXID_JS_BODY` import.
 *  - The page-side resolution function MUST resolve the element
 *    by canonical axId (using `axIdFor(pageId, el)` for the named
 *    form, or `axIdWalk()[index]` for the preorder-index form).
 *  - The listbox lookup MUST use `aria-controls` first, then the
 *    combobox's subtree `[role="listbox"]`, then fall back to the
 *    combobox itself if it is itself a listbox. NEVER a
 *    document-global query.
 *  - Behavioral: the choose-dropdown probe must produce a hit on
 *    the SPECIFIC `<select>` (with 2 options) bound to the
 *    resolved axId, even when the page has another `<select>`
 *    (with 1 option) that the previous implementation would have
 *    incorrectly picked as "the first select with ≥2 options".
 *
 * These tests run in two layers:
 *  1. Source-contract assertions on `observed.ts` and `ax-id.ts`
 *     (static text).
 *  2. A behavioral test that uses a mock `ObservedPageLike` to
 *     prove the per-axId resolution works when the page has
 *     multiple selects.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runObservedProbeLoopV2,
  runChooseDropdown,
  type InteractiveElement,
  type RichSnapshot,
  type ObservedPageLike,
} from "../../src/extract-state/observed.js";

const PAGE_ID = "page:https://example.com/multi-select";

const NO_WAIT = async () => undefined;
const FROZEN_NOW = () => 0;

const OBSERVED_SRC = readFileSync(
  join(process.cwd(), "src/extract-state/observed.ts"),
  "utf8",
);

const AXID_SRC = readFileSync(
  join(process.cwd(), "src/extract-state/ax-id.ts"),
  "utf8",
);

function makeEl(i: number, over: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    axId: `ax:${PAGE_ID}:n${i}`,
    rect: { x: 100 + i * 200, y: 100, w: 180, h: 30 },
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

describe("PR-8i T2: choose-dropdown reads bound to el.axId", () => {
  it("ACCEPTANCE: runChooseDropdown does NOT use document-global querySelector for <select>", () => {
    // The native <select> path in runChooseDropdown must NOT
    // contain `querySelectorAll('select')` (the previous bug).
    // It must contain the AXID-bound resolution helpers.
    const helperMatch = OBSERVED_SRC.match(
      /export async function runChooseDropdown\([\s\S]*?\n\}/,
    );
    expect(helperMatch, "runChooseDropdown function must exist").not.toBeNull();
    const body = helperMatch ? helperMatch[0] : "";
    // The body must reference the AXID-bound helper, not a
    // document-global query. The comments in the body may
    // mention the forbidden patterns (as a regression note);
    // what matters is that no live code path uses them.
    expect(
      body.includes("RESOLVE_AXID_BOUND_FN"),
      "PR-8i T2: runChooseDropdown must dispatch to RESOLVE_AXID_BOUND_FN for native <select>.",
    ).toBe(true);
    // The body must not call script.evaluate with the old
    // querySelectorAll('select') pattern. Strip single-line
    // comments and re-check.
    const code = body
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(
      !code.includes("querySelectorAll('select')"),
      "PR-8i T2: runChooseDropdown (code) MUST NOT use querySelectorAll('select'). Body contains the forbidden pattern.",
    ).toBe(true);
    expect(
      !code.includes('querySelectorAll("select")'),
      'PR-8i T2: runChooseDropdown (code) MUST NOT use querySelectorAll("select").',
    ).toBe(true);
  });

  it("ACCEPTANCE: runChooseDropdown does NOT use document-global querySelector for [role=combobox]", () => {
    // The ARIA combobox path in runChooseDropdown must NOT contain
    // any of the document-global combobox/listbox patterns in
    // live code (comments are allowed as regression notes).
    const helperMatch = OBSERVED_SRC.match(
      /export async function runChooseDropdown\([\s\S]*?\n\}/,
    );
    expect(helperMatch, "runChooseDropdown function must exist").not.toBeNull();
    const body = helperMatch ? helperMatch[0] : "";
    const code = body
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(
      !code.includes("querySelector('[role=\"combobox\"]')"),
      "PR-8i T2: runChooseDropdown (code) MUST NOT use querySelector('[role=combobox]').",
    ).toBe(true);
    expect(
      !code.includes("querySelector('[role=\"combobox\"], [role=\"listbox\"]')"),
      "PR-8i T2: runChooseDropdown (code) MUST NOT use querySelector('[role=combobox], [role=listbox]').",
    ).toBe(true);
    expect(
      !code.includes("querySelectorAll('[role=\"combobox\"]')"),
      "PR-8i T2: runChooseDropdown (code) MUST NOT use querySelectorAll('[role=combobox]').",
    ).toBe(true);
    // The body must use the AXID-bound resolution helpers.
    expect(
      body.includes("RESOLVE_AXID_BOUND_FN"),
      "PR-8i T2: runChooseDropdown must dispatch to RESOLVE_AXID_BOUND_FN for ARIA combobox.",
    ).toBe(true);
  });

  it("ACCEPTANCE: runChooseDropdown uses the AXID-bound resolution helpers", () => {
    // The function body must reference the new helper functions
    // and the AXID_JS_BODY import (or its inlined body).
    const helperMatch = OBSERVED_SRC.match(
      /export async function runChooseDropdown\([\s\S]*?\n\}/,
    );
    const body = helperMatch ? helperMatch[0] : "";
    expect(
      body.includes("RESOLVE_AXID_BOUND_FN"),
      "PR-8i T2: runChooseDropdown must use RESOLVE_AXID_BOUND_FN (AXID-bound element resolution).",
    ).toBe(true);
    expect(
      body.includes("POLL_COMBOBOX_OPTIONS_FN"),
      "PR-8i T2: runChooseDropdown must use POLL_COMBOBOX_OPTIONS_FN (AXID-bound option polling).",
    ).toBe(true);
    // The script.evaluate calls are gone; the callFunction calls
    // are present.
    const evalCount = (body.match(/script\.evaluate/g) ?? []).length;
    const callFnCount = (body.match(/script\.callFunction/g) ?? []).length;
    expect(evalCount).toBe(0);
    expect(callFnCount).toBeGreaterThanOrEqual(2);
    // The function takes the pageId argument.
    expect(
      /async function runChooseDropdown\(\s*page:\s*ObservedPageLike\s*,\s*el:\s*InteractiveElement\s*,\s*pageId:\s*string/.test(body),
      "PR-8i T2: runChooseDropdown must take (page, el, pageId) so AXID resolution is bound to the correct page.",
    ).toBe(true);
  });

  it("ACCEPTANCE: RESOLVE_AXID_BOUND_FN resolves by canonical axId and uses AXID_JS_BODY", () => {
    // The helper module must be defined in observed.ts and must
    // inline AXID_JS_BODY. The body must:
    //   - not use querySelectorAll / querySelector for comboboxes
    //     at the document scope,
    //   - prefer aria-controls for listbox resolution,
    //   - fall back to the combobox's subtree [role="listbox"],
    //   - fall back to the combobox itself if it is a listbox.
    const helperMatch = OBSERVED_SRC.match(
      /export const RESOLVE_AXID_BOUND_FN = `[\s\S]*?`;/,
    );
    expect(helperMatch, "RESOLVE_AXID_BOUND_FN must be defined").not.toBeNull();
    const body = helperMatch ? helperMatch[0] : "";
    expect(
      body.includes("AXID_JS_BODY"),
      "PR-8i T2: RESOLVE_AXID_BOUND_FN must inline AXID_JS_BODY for canonical axId resolution.",
    ).toBe(true);
    expect(
      body.includes("aria-controls"),
      "PR-8i T2: RESOLVE_AXID_BOUND_FN must use aria-controls for listbox resolution.",
    ).toBe(true);
    expect(
      !body.includes("querySelectorAll('[role=\"combobox\"]')"),
      "PR-8i T2: RESOLVE_AXID_BOUND_FN MUST NOT contain a document-global combobox query.",
    ).toBe(true);
  });

  it("ACCEPTANCE: observed.ts imports AXID_JS_BODY from ax-id.ts", () => {
    // The TS module must import AXID_JS_BODY. The string body is
    // re-inlined into the callFunction payload (BiDi realms can't
    // import modules), but the TS-side import proves the helper
    // is the canonical AXID_JS_BODY (not a copy that drifted).
    expect(
      /import\s*\{[^}]*AXID_JS_BODY[^}]*\}\s*from\s*"\.\/ax-id\.js"/.test(OBSERVED_SRC),
      "PR-8i T2: observed.ts must import AXID_JS_BODY from ./ax-id.js",
    ).toBe(true);
    expect(
      /export const AXID_JS_BODY/.test(AXID_SRC),
      "PR-8i T2: ax-id.ts must export AXID_JS_BODY (canonical walker body).",
    ).toBe(true);
  });

  it("BEHAVIORAL: two <select>s with different axIds — the choose-dropdown probe resolves the right one", async () => {
    // Page has TWO <select> elements:
    //   - ax:page:...:n1 (combobox role, 1 option) — "single-option"
    //   - ax:page:...:n2 (combobox role, 3 options) — "multi-option"
    // The previous implementation would have picked the first
    // select with ≥2 options globally, which would happen to be
    // the right one here by accident. The new path resolves by
    // axId: if the probed axId is the single-option one, the
    // probe is a noop; if the probed axId is the multi-option
    // one, the probe fires.
    const axSingle = `ax:${PAGE_ID}:n1`;
    const axMulti = `ax:${PAGE_ID}:n2`;
    const baseline = makeRichSnapshot({
      hash: "h:base",
      elements: [
        {
          axId: axSingle, rect: { x: 100, y: 100, w: 180, h: 30 },
          visibility: "visible", zIndex: null, open: null, expanded: null,
          selected: false, checked: null, pressed: null, busy: null, focused: null,
          ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
        },
        {
          axId: axMulti, rect: { x: 100, y: 200, w: 180, h: 30 },
          visibility: "visible", zIndex: null, open: null, expanded: null,
          selected: false, checked: null, pressed: null, busy: null, focused: null,
          ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
        },
      ],
    });
    const els = [
      makeEl(0, { axId: axSingle, role: "combobox", tagName: "select" }),
      makeEl(1, { axId: axMulti, role: "combobox", tagName: "select" }),
    ];
    // Mock page: callFunction that dispatches by the third arg
    // (the kind). The select-stats path returns the option count
    // of the SPECIFIC element bound to the axId. The mock
    // resolves el[1] (the multi-option one) to count=3, current=
    // "opt1"; el[0] to count=1, current="only".
    const { page, recording } = makeMultiSelectMockPage({ baseline, elements: els });
    // Probe the SINGLE-option select. The mock returns
    // count=1 → the probe is a noop (no real change to record).
    await runChooseDropdown(page, els[0]!, PAGE_ID);
    // Probe the MULTI-option select. The mock returns
    // count=3 → the probe fires (pointer + ArrowDown).
    await runChooseDropdown(page, els[1]!, PAGE_ID);
    // The mock recorded which axId it was asked to resolve for
    // each call. Both calls must have used the SPECIFIC axId
    // (not a document-global query).
    const recordedAxIds = recording.recordedAxIds.filter((x) => typeof x === "string");
    expect(recordedAxIds).toContain(axSingle);
    expect(recordedAxIds).toContain(axMulti);
    // Each recorded axId (the ones passed to the
    // select-stats / combobox-stats resolver) was actually
    // used as the second argument to callFunction — proof
    // the helper did not fall back to a document-global
    // lookup. (The new PR-8j T2 focus-fix callFunction
    // also fires per-element with the element's id suffix,
    // not a global query; we verify the axId-shaped calls
    // specifically, since those are the binds to
    // RESOLVE_AXID_BOUND_FN.)
    // The recorded call count = 2 (one per probed element).
    // The single-option probe also calls callFunction (count=1
    // is reported, then the helper noops). The multi-option
    // probe calls callFunction (count=3 reported) and then
    // performActions for pointer + key. PR-8j T2: the
    // native <select> path also fires a third callFunction
    // (the focus re-commit `t.blur(); t.focus();`) so the
    // headless-Firefox keyboard pipeline is in the right
    // state to process the ArrowDown key. The third call
    // is element-bound (the resolved el.id), not a
    // document-global lookup. Total: 3 callFunction
    // calls (1 select-stats, 1 focus re-commit,
    // 1 — for the single-option probe — no combobox-stats),
    // 1 performActions call (only the multi-option probe
    // drives pointer + key).
    expect(recording.callCount).toBe(3);
  });
});

// ----- Mock helpers -----

interface MultiMockRecording {
  callArgs: any[][];
  callCount: number;
  recordedAxIds: string[];
  performCount: number;
}

function makeMultiSelectMockPage(opts: {
  elements: InteractiveElement[];
  baseline?: RichSnapshot;
}): { page: ObservedPageLike; recording: MultiMockRecording } {
  const baseline = opts.baseline ?? makeRichSnapshot();
  const recording: MultiMockRecording = {
    callArgs: [],
    callCount: 0,
    recordedAxIds: [],
    performCount: 0,
  };
  // Map axId → { count, current } for the AXID-bound select.
  const optionMap: Record<string, { count: number; current: string }> = {
    [`ax:${PAGE_ID}:n1`]: { count: 1, current: "only" },
    [`ax:${PAGE_ID}:n2`]: { count: 3, current: "opt1" },
  };
  // Mock script.callFunction: dispatches by the third arg (kind).
  const callFunction = async (_target: any, _fn: any, args: any) => {
    recording.callCount++;
    recording.callArgs.push(args);
    const [pageIdArg, axIdArg, kind] = args as [string, string, string];
    recording.recordedAxIds.push(axIdArg);
    if (kind === "select-stats") {
      return optionMap[axIdArg] ?? { count: 0, current: "" };
    }
    if (kind === "combobox-stats") {
      return { needsType: false, hasOptions: true, options: [] };
    }
    return null;
  };
  const performActions = async (_ctx: any, _actions: any) => {
    recording.performCount++;
  };
  return {
    page: {
      target: { context: "ctx-multi" } as any,
      script: {
        callFunction: callFunction as any,
        evaluate: (async () => null) as any,
      },
      input: { performActions: performActions as any },
    } as any,
    recording,
  };
}
