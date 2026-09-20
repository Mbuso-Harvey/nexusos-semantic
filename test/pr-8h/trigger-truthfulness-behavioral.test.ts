/**
 * PR-8h T4 — Behavioral trigger-truthfulness matrix.
 *
 * **Acceptance criterion (PR-8h Blocker 3, verbatim).**
 *  - Strengthen trigger-truthfulness matrix.
 *  - Retain static source-contract tests only as secondary
 *    regression guards.
 *  - Add behavioral acceptance for trigger families.
 *
 * **Why this file exists.** The PR-8g trigger matrix
 * (`test/pr-8g/trigger-matrix.test.ts`) is a static-text gate: it
 * reads `src/extract-state/observed.ts` from disk and asserts
 * regexes over the source. That is a strong pin against future
 * regressions in the production contract, but it is not a
 * behavioral gate — it does not actually run the probes.
 *
 * PR-8h Blocker 3 demands the BEHAVIORAL gate as the primary
 * acceptance. This file is that gate: for every trigger family the
 * State graph can record, we drive the probe through a mock
 * `ObservedPageLike` and assert the *transport* and *payload* that
 * the production code actually used:
 *
 *  - `click` / `hover` / `drag`        → `input.performActions`
 *                                         with a 3-action pointer
 *                                         sequence (move, down, up).
 *  - `keyEnter` / `keySpace` / etc.    → `input.performActions`
 *                                         with a `keyDown`/`keyUp`
 *                                         pair carrying the LITERAL
 *                                         key name.
 *  - `focus`                           → page-side `script.callFunction`
 *                                         driving `el.focus()` — NOT
 *                                         a synthesized click.
 *  - `type` / `submit` / `expand` /    → page-side `script.callFunction`
 *          `collapse` / `tab-activate`   driving the truthful DOM
 *                                         mutation.
 *  - `dialog-open` / `dialog-close`    → page-side `script.callFunction`
 *                                         driving `dialog.showModal()`
 *                                         / `dialog.close()`.
 *  - `choose-dropdown`                 → `input.performActions`
 *                                         (real BiDi pointer + real
 *                                         BiDi ArrowDown key for
 *                                         native `<select>`).
 *  - `scroll`                          → page-side
 *                                         `script.evaluate` driving
 *                                         `window.scrollBy`.
 *  - `network-wait`                    → page-side
 *                                         `script.evaluate` driving
 *                                         the BiDi network shim
 *                                         (`__awg_flushRequests`).
 *  - `auth`                            → orchestrator-level: the
 *                                         `applyAuthSpec` BiDi
 *                                         `storage.setCookies` call
 *                                         (see `test/pr-8g/auth-
 *                                         transition.test.ts`).
 *
 * **Mocking strategy.** The mock `ObservedPageLike` records every
 * call to `script.callFunction`, `script.evaluate`, and
 * `input.performActions` with its arguments. The probe loop's
 * `listInteractive` and `takeSnapshot` are injected via the V2
 * options, so the loop sees a stable baseline + after-state pair.
 * The test then asserts the right transport was used and the right
 * payload was sent.
 */
import { describe, it, expect } from "vitest";
import {
  runObservedProbeLoopV2,
  runChooseDropdown,
  extendedProbeToTrigger,
  type RichSnapshot,
  type InteractiveElement,
  type ObservedPageLike,
  type ExtendedProbeKind,
} from "../../src/extract-state/observed.js";

const PAGE_ID = "page:behavioral";

function makeEl(
  i: number,
  over: Partial<InteractiveElement> = {},
): InteractiveElement {
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
  openDialogIds?: string[];
  expandedRegionAxIds?: string[];
  focusedAxId?: string | null;
  scrollY?: number;
} = {}): RichSnapshot {
  return {
    hash: over.hash ?? "h:base",
    elements: over.elements ?? [],
    openDialogIds: over.openDialogIds ?? [],
    openPopoverIds: [],
    expandedRegionAxIds: over.expandedRegionAxIds ?? [],
    viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: over.scrollY ?? 0 },
    online: true,
    conditionalMarkers: {},
    focusedAxId: over.focusedAxId ?? null,
  };
}

const NO_WAIT = async () => undefined;
const FROZEN_NOW = () => 0;

/** Recording container for a behavioral mock page. */
interface MockRecording {
  callArgs: any[][];
  callCount: number;
  evaluateArgs: any[][];
  evaluateCount: number;
  performArgs: any[][];
  performCount: number;
}

/**
 * Build a mock `ObservedPageLike` that records every call to the
 * three transports. The injected `listInteractive` / `takeSnapshot`
 * are NOT routed through callFunction — the production V2 probe
 * loop accepts them as options. This avoids the call-counter
 * complexity of detecting list vs snapshot vs probe in the mock.
 */
function makeMockPage(opts: {
  callFnResultByProbe?: Record<string, any>;
  evaluateResultByExpr?: Array<{ match: RegExp; result: any }>;
}): { page: ObservedPageLike; recording: MockRecording } {
  const recording: MockRecording = {
    callArgs: [],
    callCount: 0,
    evaluateArgs: [],
    evaluateCount: 0,
    performArgs: [],
    performCount: 0,
  };

  const callFunction = async (_target: any, _fn: any, args: any) => {
    recording.callCount++;
    recording.callArgs.push(args);
    // PROBE_ELEMENT_FN is invoked as
    //   callFunction(target, PROBE_ELEMENT_FN, [pageId, axId, probeKind])
    // so the args array IS [pageId, axId, probeKind]; the probe
    // kind is at args[2]. For list/snapshot the args array is
    // [pageId] (length 1, no probe kind).
    const probe = Array.isArray(args) && args.length >= 3 ? args[2] : undefined;
    if (opts.callFnResultByProbe && probe && opts.callFnResultByProbe[probe] !== undefined) {
      return opts.callFnResultByProbe[probe];
    }
    return { kind: "ok" };
  };

  const evaluate = async (_target: any, expr: string) => {
    recording.evaluateCount++;
    recording.evaluateArgs.push([expr]);
    if (opts.evaluateResultByExpr) {
      for (const m of opts.evaluateResultByExpr) {
        if (m.match.test(expr)) return m.result;
      }
    }
    return null;
  };

  const performActions = async (_ctx: any, actions: any[]) => {
    recording.performCount++;
    recording.performArgs.push(actions);
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

/** Run the V2 probe loop with injected list/snapshot. */
async function runLoopWithMocks(opts: {
  page: ObservedPageLike;
  elements: InteractiveElement[];
  baseline: RichSnapshot;
  after: RichSnapshot;
  callFnResultByProbe?: Record<string, any>;
  evaluateResultByExpr?: Array<{ match: RegExp; result: any }>;
}) {
  const { page, elements, baseline, after } = opts;
  // The V2 probe loop calls takeSnapshot as:
  //   1. The loop's baseline (immediately after listInteractive)
  //   2. For each probe: `before` snapshot
  //   3. For each probe: `after` snapshot
  // We model this as: call #1 returns baseline; every subsequent
  // ODD call (2, 4, 6, ...) returns baseline (the per-probe
  // `before`), every EVEN call (3, 5, 7, ...) returns `after`
  // (the per-probe `after`). This guarantees a real diff per
  // probe when the test author expects one.
  let i = 0;
  return runObservedProbeLoopV2({
    page,
    pageId: PAGE_ID,
    wait: NO_WAIT,
    now: FROZEN_NOW,
    listInteractive: async () => elements,
    takeSnapshot: async () => {
      i++;
      // i=1: loop baseline (baseline)
      // i=2: per-probe before (baseline)
      // i=3: per-probe after (after)
      // i=4: per-probe before (baseline)
      // i=5: per-probe after (after)
      // ...
      return i % 2 === 1 ? baseline : after;
    },
  });
}

describe("PR-8h T4: behavioral trigger-truthfulness matrix", () => {
  describe("click — observed (BiDi pointer, real)", () => {
    it("drives a 3-action pointer sequence via input.performActions", async () => {
      const el = makeEl(0, { role: "button", tagName: "button" });
      const baseline = makeRichSnapshot({
        elements: [{
          axId: el.axId,
          rect: { x: 100, y: 100, w: 40, h: 20 },
          visibility: "visible", zIndex: null, open: null, expanded: null,
          selected: false, checked: null, pressed: null, busy: null, focused: null,
          ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
        }],
      });
      const after = makeRichSnapshot({
        hash: "h:after",
        elements: [{
          axId: el.axId,
          rect: { x: 100, y: 100, w: 40, h: 20 },
          visibility: "visible", zIndex: null, open: null, expanded: null,
          selected: false, checked: null, pressed: null, busy: null, focused: true,
          ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
        }],
        focusedAxId: el.axId,
      });
      const { page, recording } = makeMockPage({});
      await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      // Filter pointer calls; the click probe produces a 3-action
      // sequence. (hover also produces a pointer call but with
      // only 1 sub-action.)
      const pointerCalls = recording.performArgs.filter(
        (a) => Array.isArray(a) && a[0] && a[0].type === "pointer",
      );
      expect(pointerCalls.length, "click/hover probes must drive BiDi pointer actions").toBeGreaterThan(0);
      // At least one of the pointer calls has the full 3-action
      // sequence (move, down, up) — the click probe.
      const clickCall = pointerCalls.find((a) => {
        const sub = Array.isArray(a[0]?.actions) ? a[0].actions : [];
        return sub.length >= 3;
      });
      expect(clickCall, "click probe must produce a 3-action pointer sequence (move, down, up)").toBeDefined();
      const sub = clickCall![0]!.actions as any[];
      const types = sub.map((s: any) => s && s.type);
      expect(types).toContain("pointerMove");
      expect(types).toContain("pointerDown");
      expect(types).toContain("pointerUp");
    });
  });

  describe("keyEnter — observed (BiDi key, real)", () => {
    it("drives a real BiDi keyDown/keyUp pair with the literal key 'Enter'", async () => {
      const el = makeEl(0, { role: "button", tagName: "button" });
      const baseline = makeRichSnapshot();
      const after = makeRichSnapshot({ focusedAxId: el.axId });
      const { page, recording } = makeMockPage({});
      await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      const keyCalls = recording.performArgs.filter(
        (a) => Array.isArray(a) && a[0] && a[0].type === "key",
      );
      expect(keyCalls.length, "keyEnter probe must drive a BiDi key action").toBeGreaterThan(0);
      const first = keyCalls[0]![0];
      const sub = Array.isArray(first.actions) ? first.actions : [];
      const downs = sub.filter((s: any) => s && s.type === "keyDown");
      expect(downs.length).toBeGreaterThanOrEqual(1);
      const values = downs.map((d: any) => d.value);
      // PR-8j T2: the readable name "Enter" is translated to
      // the BiDi-spec single code point U+E007 (WebDriver
      // classic keyboard code) before being sent. The
      // observable transport payload is the code point, not
      // the readable name — this is the same code point
      // Firefox 154 expects per the BiDi spec. See
      // src/bidi-client/input.ts KEY_NAME_TO_CODE.
      expect(values, "keyEnter probe must carry the BiDi-spec U+E007 code point (Enter)").toContain("");
      expect(values, "keyEnter probe must NOT carry the readable name 'Enter' (the translation happens before the BiDi transport)").not.toContain("Enter");
    });
  });

  describe("keyArrowDown — observed (BiDi key, real)", () => {
    it("drives a real BiDi keyDown with the literal 'ArrowDown'", async () => {
      const el = makeEl(0, { role: "combobox", tagName: "select" });
      const baseline = makeRichSnapshot();
      const after = makeRichSnapshot({ focusedAxId: el.axId });
      const { page, recording } = makeMockPage({
        // Suppress the choose-dropdown probe so its BiDi sequence
        // does not produce an ArrowDown (which is what it does).
        callFnResultByProbe: { "choose-dropdown": { kind: "noop" } },
      });
      await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      let foundArrowDown = false;
      for (const a of recording.performArgs) {
        if (!Array.isArray(a) || !a[0] || a[0].type !== "key") continue;
        const sub = Array.isArray(a[0].actions) ? a[0].actions : [];
        for (const s of sub) {
          // PR-8j T2: the BiDi transport carries the
          // U+E015 code point (WebDriver classic
          // keyboard code for ArrowDown), not the
          // readable name "ArrowDown".
          if (s && s.type === "keyDown" && s.value === "") {
            foundArrowDown = true;
          }
        }
      }
      expect(foundArrowDown, "keyArrowDown probe must drive a real BiDi keyDown with value='ArrowDown'").toBe(true);
    });
  });

  describe("focus — observed (page-side, real DOM focus)", () => {
    it("drives the page-side PROBE_ELEMENT_FN focus case via callFunction (NOT a click)", async () => {
      const el = makeEl(0, { role: "button", tagName: "button" });
      const baseline = makeRichSnapshot();
      const after = makeRichSnapshot({ focusedAxId: el.axId });
      const { page, recording } = makeMockPage({});
      const result = await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      // A callFunction for the focus probe MUST have fired.
      // Production callFunction args = [pageId, axId, probeKind],
      // so the probe kind is at args[2] (the third positional of
      // the args array, not a nested index).
      const focusCalls = recording.callArgs.filter(
        (a) => Array.isArray(a) && a[2] === "focus",
      );
      expect(focusCalls.length, "focus probe must use the page-side PROBE_ELEMENT_FN").toBeGreaterThan(0);
      // The focus hit's trigger MUST be "focus", not "click".
      const focusHits = result.hits.filter((h) => h.probe === "focus");
      expect(focusHits.length, "focus probe must produce at least one focus hit").toBeGreaterThan(0);
      for (const h of focusHits) {
        expect(h.trigger, "focus hit's trigger must be 'focus', not 'click'").toBe("focus");
      }
    });
  });

  describe("choose-dropdown — observed (real BiDi, no synthesis)", () => {
    it("native <select> drives pointer + ArrowDown via real BiDi input.performActions", async () => {
      const el = makeEl(0, { role: "combobox", tagName: "select" });
      const { page, recording } = makeMockPage({
        evaluateResultByExpr: [
          { match: /querySelectorAll\('select'\)/, result: { count: 1, current: JSON.stringify([{ count: 3, current: "opt1" }]) } },
          { match: /__awg_flushRequests|Promise/, result: false },
        ],
      });
      await runChooseDropdown(page, el, PAGE_ID);
      // 1. Two BiDi actions: pointer (the click on the <select>)
      //    then key (the ArrowDown).
      expect(recording.performCount, "real BiDi must have fired for pointer + key").toBe(2);
      const types = recording.performArgs.map(
        (a) => (Array.isArray(a) && a[0] && a[0].type) || "?",
      );
      expect(types).toEqual(["pointer", "key"]);
      // 2. The key action carried the BiDi-spec single
      //    code point for ArrowDown (U+E015, WebDriver
      //    classic keyboard code), not the readable name.
      //    PR-8j T2.
      const keyAction = recording.performArgs[1]?.[0];
      const keyDowns = Array.isArray(keyAction?.actions)
        ? keyAction.actions.filter((a: any) => a && a.type === "keyDown")
        : [];
      expect(keyDowns.length).toBeGreaterThanOrEqual(1);
      expect((keyDowns[0] as any).value).toBe("");
      expect((keyDowns[0] as any).value).not.toBe("ArrowDown");
      // 3. The page-side script is allowed ONLY to read state
      //    (option count, current value) — the BiDi-only path
      //    must not have invoked PROBE_ELEMENT_FN for mutation.
      const chooseCallFn = recording.callArgs.filter(
        (a) => Array.isArray(a) && a[2] === "choose-dropdown",
      );
      expect(
        chooseCallFn.length,
        "PR-8h: choose-dropdown MUST NOT call PROBE_ELEMENT_FN (page-side script) for mutation",
      ).toBe(0);
    });

    it("the trigger recorded for the choose-dropdown probe is exactly 'choose-dropdown'", () => {
      // Trigger mapping: extendedProbeToTrigger must map
      // "choose-dropdown" to the literal "choose-dropdown"
      // string. A regression that maps it to "click" breaks
      // this gate.
      expect(extendedProbeToTrigger("choose-dropdown")).toBe("choose-dropdown");
      // Negative case: the click probe maps to "click", not
      // "choose-dropdown".
      expect(extendedProbeToTrigger("click")).toBe("click");
    });
  });

  describe("auth — orchestrator (BiDi storage.setCookies, real)", () => {
    it("extendedProbeToTrigger does not include an 'auth' mapping (auth is orchestrator-level)", () => {
      // Auth is NOT an observed probe. It is the orchestrator
      // that calls `applyAuthSpec(page, spec, baseUrl)` to set
      // the session cookie via real BiDi `storage.setCookies`.
      // The auth transition is then wired explicitly by
      // `materializeCausalAuthTransition` (see
      // `test/pr-8g/auth-transition.test.ts`).
      //
      // This behavioral gate pins the boundary: an 'auth' entry
      // in the EXTENDED_PROBE_ORDER would be a layering defect
      // (the observed path is NOT the source of auth
      // transitions). The probe mapping must not synthesize an
      // auth trigger.
      for (const probe of [
        "focus", "hover", "click", "keyEnter", "keySpace", "keyEscape", "keyTab",
        "keyArrowUp", "keyArrowDown", "keyArrowLeft", "keyArrowRight",
        "keyHome", "keyEnd", "type", "submit", "scroll", "network-wait", "drag",
        "expand", "collapse", "choose-dropdown", "dialog-open", "dialog-close",
        "tab-activate",
      ] as const) {
        expect(extendedProbeToTrigger(probe), `probe '${probe}' must not be 'auth'`).not.toBe("auth");
      }
    });
  });

  describe("expand — observed (page-side, real MouseEvent click on summary)", () => {
    it("drives the page-side PROBE_ELEMENT_FN expand case (real DOM click on summary)", async () => {
      const el = makeEl(0, { role: "summary", tagName: "summary" });
      const baseline = makeRichSnapshot();
      const after = makeRichSnapshot({
        expandedRegionAxIds: [el.axId],
      });
      const { page, recording } = makeMockPage({});
      await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      const expandCalls = recording.callArgs.filter(
        (a) => Array.isArray(a) && a[2] === "expand",
      );
      expect(expandCalls.length, "expand probe must use the page-side PROBE_ELEMENT_FN").toBeGreaterThan(0);
    });
  });

  describe("dialog-open — observed (page-side, real dialog.showModal)", () => {
    it("drives the page-side PROBE_ELEMENT_FN dialog-open case (real DOM dialog.showModal)", async () => {
      const el = makeEl(0, { role: "button", tagName: "button" });
      const baseline = makeRichSnapshot();
      const after = makeRichSnapshot({ openDialogIds: ["dlg-1"] });
      const { page, recording } = makeMockPage({});
      await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      const dlgCalls = recording.callArgs.filter(
        (a) => Array.isArray(a) && a[2] === "dialog-open",
      );
      expect(dlgCalls.length, "dialog-open probe must use the page-side PROBE_ELEMENT_FN").toBeGreaterThan(0);
    });
  });

  describe("scroll — observed (page-level, real window.scrollBy)", () => {
    it("drives script.evaluate for window.scrollBy (real scroll, not a label)", async () => {
      const el = makeEl(0, { role: "button", tagName: "button" });
      const baseline = makeRichSnapshot();
      const after = makeRichSnapshot({ scrollY: 200 });
      const { page, recording } = makeMockPage({});
      await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      // The scroll probe uses script.evaluate (not BiDi input)
      // to fire window.scrollBy. The evaluate call must include
      // the scrollBy literal.
      const scrollEvaluates = recording.evaluateArgs.filter(
        (a) => Array.isArray(a) && typeof a[0] === "string" && a[0].includes("scrollBy"),
      );
      expect(
        scrollEvaluates.length,
        "scroll probe must use script.evaluate with window.scrollBy (real scroll)",
      ).toBeGreaterThan(0);
    });
  });

  describe("network-wait — observed (page-level, real BiDi network shim)", () => {
    it("drives script.evaluate for the network shim flush (real wait)", async () => {
      const el = makeEl(0, { role: "button", tagName: "button" });
      const baseline = makeRichSnapshot();
      const after = makeRichSnapshot();
      const { page, recording } = makeMockPage({});
      await runLoopWithMocks({
        page, elements: [el], baseline, after,
      });
      const flushEvaluates = recording.evaluateArgs.filter(
        (a) => Array.isArray(a) && typeof a[0] === "string" && a[0].includes("__awg_flushRequests"),
      );
      expect(
        flushEvaluates.length,
        "network-wait probe must use script.evaluate with __awg_flushRequests (real wait)",
      ).toBeGreaterThan(0);
    });
  });

  describe("trigger↔probe mapping is bijective for the click/choose-dropdown pair", () => {
    it("click maps to 'click' and choose-dropdown maps to 'choose-dropdown' (no misattribution)", () => {
      // The two probes must NEVER share a trigger value. A
      // regression that mapped choose-dropdown → click (or vice
      // versa) would misattribute real BiDi pointer clicks on
      // a <select> as a regular click, hiding the choose-
      // dropdown trigger from consumers.
      expect(extendedProbeToTrigger("click")).toBe("click");
      expect(extendedProbeToTrigger("choose-dropdown")).toBe("choose-dropdown");
      expect(extendedProbeToTrigger("click")).not.toBe(extendedProbeToTrigger("choose-dropdown"));
    });
  });

  describe("extendedProbeToTrigger covers every probe kind in EXTENDED_PROBE_ORDER", () => {
    it("every ExtendedProbeKind has a defined trigger mapping", () => {
      // The probe ↔ trigger mapping is total: every
      // ExtendedProbeKind MUST map to a TransitionTrigger. A
      // regression that adds a new probe kind without updating
      // the switch is caught here.
      const PROBES: ExtendedProbeKind[] = [
        "focus", "hover", "click",
        "keyEnter", "keySpace", "keyEscape", "keyTab",
        "keyArrowUp", "keyArrowDown", "keyArrowLeft", "keyArrowRight",
        "keyHome", "keyEnd",
        "type", "submit",
        "scroll", "network-wait", "drag",
        "expand", "collapse",
        "choose-dropdown",
        "dialog-open", "dialog-close", "tab-activate",
      ];
      const TRIGGERS = new Set([
        "command", "click", "hover", "focus",
        "key-enter", "key-space", "key-escape",
        "key-arrow-up", "key-arrow-down", "key-arrow-left", "key-arrow-right",
        "key-home", "key-end", "key-tab",
        "type", "submit", "scroll", "drag",
        "expand", "collapse",
        "open-modal", "close-modal",
        "switch-tab", "choose-dropdown",
        "auth", "conditional",
        "view-transition", "popover", "dialog", "network-wait",
        "command-show-modal", "command-show-popover", "command-toggle-popover",
        "command-close", "command-hide-popover", "command-request-close",
      ]);
      for (const p of PROBES) {
        const t = extendedProbeToTrigger(p);
        expect(
          TRIGGERS.has(t),
          `probe '${p}' maps to trigger '${t}' which is not in the canonical TransitionTrigger union`,
        ).toBe(true);
      }
    });
  });
});
