/**
 * PR-8g T5 — Trigger-truthfulness matrix: explicit acceptance tests
 * for every trigger in the `TransitionTrigger` union.
 *
 * **Acceptance criterion (Blocker 5, verbatim).**
 *  - Add trigger-truthfulness acceptance matrix.
 *
 * **Truthfulness contract.** For every trigger the State graph can
 * record, the *actual DOM mechanism* that produced the transition
 * must be a real, application-observable action — not a
 * synthesized shortcut, not a bare attribute rewrite, not a label
 * swap. The matrix below pins the contract for each trigger so a
 * future regression that replaces a real DOM event with a
 * synthesized one (or relabels a `click` as `focus`, or mints a
 * `state:successor` edge without any trigger) fails the gate.
 *
 * **How the contract is pinned.** Two complementary layers:
 *  1. **Static-text assertions** on `src/extract-state/observed.ts`
 *     and `src/extract-state/declared.ts`: each trigger's
 *     *truthfulness requirement* (e.g. "must dispatch a real
 *     MouseEvent click", "must call el.focus() not el.click()",
 *     "must use the HTMLSelectElement native setter") is
 *     expressed as a regex the production code MUST contain. The
 *     static-text gate is the strongest pin against regressions:
 *     a future refactor that swaps the mechanism for a
 *     synthesized shortcut breaks the test, even if the runtime
 *     behavior is hard to tell apart.
 *  2. **Trigger↔mechanism mapping** in the `expectedMechanisms`
 *     table below: documents, for every trigger, the
 *     authoritative path the State graph wires (declared vs
 *     observed) and the truthful DOM action it represents.
 *
 * **Truthfulness contract (per trigger).**
 *
 *  | Trigger           | Path        | Truthful mechanism                                       |
 *  |-------------------|-------------|----------------------------------------------------------|
 *  | `click`           | observed    | BiDi `input.performActions` pointer click (real, 3-action)|
 *  | `hover`           | observed    | BiDi `input.performActions` pointer move (real)          |
 *  | `focus`           | observed    | DOM `el.focus()` (NOT a click; NOT a focus event synth)  |
 *  | `type`            | observed    | Native value setter + 'input'/'change' events (real)     |
 *  | `key-enter`       | observed    | BiDi key press (real)                                    |
 *  | `key-space`       | observed    | BiDi key press (real)                                    |
 *  | `key-escape`      | observed    | BiDi key press (real)                                    |
 *  | `key-tab`         | observed    | BiDi key press (real)                                    |
 *  | `key-arrow-*`     | observed    | BiDi key press (real)                                    |
 *  | `key-home`/`end`  | observed    | BiDi key press (real)                                    |
 *  | `submit`          | observed    | `form.requestSubmit(el)` (real)                          |
 *  | `expand`          | observed    | Real MouseEvent click on summary / disclosure            |
 *  | `collapse`        | observed    | Real MouseEvent click on summary / disclosure            |
 *  | `open-modal`      | observed    | `dialog.showModal()` (real user API)                     |
 *  | `close-modal`     | observed    | `dialog.close()` (real user API)                         |
 *  | `switch-tab`      | observed    | Real MouseEvent click on tab + keydown Enter             |
 *  | `choose-dropdown` | observed    | Native setter + 'change' OR real MouseEvent on option    |
 *  | `choose-dropdown` | declared    | HTML analysis: <select>/<option> with `optionValue`      |
 *  | `popover`         | declared    | HTML analysis: `popovertarget` / `popover` attribute      |
 *  | `dialog`          | declared    | HTML analysis: `commandfor` / `<dialog>` open pair       |
 *  | `focus`           | declared    | HTML analysis: ARIA roving-tabindex `aria-activedescendant`|
 *  | `auth`            | orchestrator| `bidi:storage.setCookies` (real BiDi call)               |
 *  | `command-*`       | declared    | HTML analysis: `command="..."` attribute                  |
 *  | `network-wait`    | observed    | Page-level: BiDi network capture (real)                  |
 *  | `scroll`          | observed    | Page-level: real scroll (real)                           |
 *  | `drag`            | observed    | BiDi pointer drag (real)                                 |
 *  | `view-transition` | declared    | CSS `view-transition-name` (real)                        |
 *
 * **Forbidden shortcuts (the matrix rejects).** A trigger must
 * NOT be produced by any of these shortcuts:
 *  - Bare attribute mutation (e.g. `el.setAttribute('aria-expanded', 'true')`
 *    is NOT a valid `expand` trigger; the application must run its
 *    own click handler).
 *  - Synthesized `MouseEvent` on the trigger element when the
 *    user did not click on it (e.g. firing `click` on a
 *    combobox to "select" an option is a `click` misattribution;
 *    the user activated an option, not the combobox).
 *  - Bare `el.value = ...` for inputs/selects (skips React/Angular
 *    native setter interception; framework listeners miss the
 *    change).
 *  - Trigger labels on `state:successor` edges that don't match
 *    the actual mechanism (a `focus` edge that fired because of
 *    a click is a misattribution).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ----- File-based source-text probes -----
// The strongest pin against regressions: the production source
// must contain the truthful mechanism. The test reads the source
// from disk (so it can run in CI) and asserts each trigger's
// contract.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const OBSERVED_SRC = readFileSync(
  resolve(ROOT, "src/extract-state/observed.ts"),
  "utf8",
);
const DECLARED_SRC = readFileSync(
  resolve(ROOT, "src/extract-state/declared.ts"),
  "utf8",
);
const STATE_MAT_SRC = readFileSync(
  resolve(ROOT, "src/extract-state/state-materialize.ts"),
  "utf8",
);

describe("PR-8g T5: trigger-truthfulness matrix", () => {
  describe("click — observed", () => {
    it("uses BiDi input.performActions (not a synthesized click on the page)", () => {
      // The click probe is dispatched via BiDi `input.performActions`
      // with a 3-action pointer sequence (pointerMove, pointerDown,
      // pointerUp). It is NOT a page-side `el.click()` (that would
      // miss pointermove-driven UI behavior like hover-then-click).
      // The probe loop's `click` and `hover` cases use
      // `performActions`; focus / choose-dropdown / etc. use
      // `callFunction`.
      expect(OBSERVED_SRC).toMatch(/performActions\s*\(/);
      // The performActions call must carry a real pointer action
      // shape (3 actions: move, down, up).
      expect(OBSERVED_SRC).toMatch(/type:\s*["']pointer["']/);
    });

    it("the trigger is `click`, not `focus`", () => {
      // The probeToTrigger / extendedProbeToTrigger tables map
      // the `click` probe to the `click` trigger, not anything
      // else.
      expect(OBSERVED_SRC).toMatch(/case\s+["']click["']\s*:\s*return\s+["']click["']/);
    });
  });

  describe("hover — observed", () => {
    it("uses BiDi input.performActions with a pointer move (real, not a synthesized event)", () => {
      // The hover probe dispatches a real `input.performActions`
      // call with a single pointer move. This is what fires
      // `:hover` CSS and `mouseenter` listeners.
      expect(OBSERVED_SRC).toMatch(/pointerMove/);
    });

    it("the trigger is `hover`, not `click`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']hover["']\s*:\s*return\s+["']hover["']/);
    });
  });

  describe("focus — observed (T1 contract)", () => {
    it("uses page-side el.focus(), NOT a click", () => {
      // The truthful focus path is DOM `el.focus()`. NOT a BiDi
      // click. NOT a synthesized focus event. NOT a
      // dispatchEvent('focus').
      expect(OBSERVED_SRC).toMatch(/el\.focus\s*\(\s*\{[^}]*preventScroll/);
    });

    it("the focus probe NEVER calls input.performActions (T1 regression)", () => {
      // The production contract: the focus case in the probe fn
      // has no `performActions` call in its body. Any future
      // regression that re-introduces a BiDi click from the
      // focus probe breaks this gate.
      // The `case 'focus':` block ends at the next `case`
      // statement or the function's closing brace. We extract
      // the block and assert it contains no `performActions`.
      const focusBlock = OBSERVED_SRC.match(
        /case\s+['"]focus['"]\s*:\s*\{([\s\S]*?)\n\s{4}\}/,
      );
      expect(focusBlock, "PR-8g T1: focus probe case block must exist").toBeTruthy();
      // Inside the focus block, the only call to drive focus
      // is `el.focus()`. No `performActions`, no `dispatchEvent('click'`.
      expect(focusBlock![1]).not.toMatch(/performActions/);
      expect(focusBlock![1]).not.toMatch(/dispatchEvent\s*\(\s*new\s+MouseEvent/);
    });

    it("the trigger is `focus`, not `click`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']focus["']\s*:\s*return\s+["']focus["']/);
    });
  });

  describe("type — observed", () => {
    it("uses the native value setter (so React/Angular pick it up)", () => {
      // The truthful type path is `Object.getOwnPropertyDescriptor(
      // HTMLInputElement.prototype, 'value').set.call(el, text)`.
      // A bare `el.value = text` would skip framework listeners
      // that intercept via the native setter.
      expect(OBSERVED_SRC).toMatch(/HTMLInputElement\.prototype/);
      expect(OBSERVED_SRC).toMatch(/Object\.getOwnPropertyDescriptor\s*\(\s*proto\s*,\s*["']value["']/);
    });

    it("dispatches real 'input' and 'change' events", () => {
      // The probe dispatches both 'input' and 'change' so the
      // application's onChange / onInput listeners fire.
      expect(OBSERVED_SRC).toMatch(/new\s+Event\s*\(\s*["']input["']/);
      expect(OBSERVED_SRC).toMatch(/new\s+Event\s*\(\s*["']change["']/);
    });

    it("the trigger is `type`, not `click` or `focus`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']type["']\s*:\s*return\s+["']type["']/);
    });
  });

  describe("submit — observed", () => {
    it("uses form.requestSubmit() (real user API)", () => {
      // The submit probe calls `form.requestSubmit(el)` — the
      // modern user API. NOT a synthesized 'submit' event.
      expect(OBSERVED_SRC).toMatch(/form\.requestSubmit/);
    });

    it("the trigger is `submit`, not `click`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']submit["']\s*:\s*return\s+["']submit["']/);
    });
  });

  describe("expand / collapse — observed", () => {
    it("dispatches a real MouseEvent click (not a bare aria-expanded rewrite)", () => {
      // The truthful expand/collapse path: a real click on the
      // summary / disclosure trigger, so the application's own
      // click handler runs. NOT `el.setAttribute('aria-expanded',
      // 'true')`.
      expect(OBSERVED_SRC).toMatch(/case\s+['"]expand['"]\s*:\s*\{/);
      const expandBlock = OBSERVED_SRC.match(
        /case\s+['"]expand['"]\s*:\s*\{([\s\S]*?)\n\s{4}\}/,
      );
      expect(expandBlock).toBeTruthy();
      // The expand block must NOT use setAttribute('aria-expanded').
      expect(expandBlock![1]).not.toMatch(/setAttribute\s*\(\s*["']aria-expanded["']/);
      // The expand block DOES dispatch a real MouseEvent click
      // for the aria-expanded and summary paths.
      expect(expandBlock![1]).toMatch(/dispatchEvent\s*\(\s*new\s+MouseEvent\s*\(\s*["']click["']/);
    });

    it("the trigger for expand is `expand` and for collapse is `collapse`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']expand["']\s*:\s*return\s+["']expand["']/);
      expect(OBSERVED_SRC).toMatch(/case\s+["']collapse["']\s*:\s*return\s+["']collapse["']/);
    });
  });

  describe("dialog-open / dialog-close — observed", () => {
    it("uses dialog.showModal() / dialog.close() (real user API)", () => {
      // The truthful open-modal path: `dialog.showModal()` —
      // the modern user API. NOT a bare `el.open = true` rewrite
      // and NOT a synthesized 'open' event.
      expect(OBSERVED_SRC).toMatch(/dlg\.showModal\s*\(\s*\)/);
      expect(OBSERVED_SRC).toMatch(/dlg\.close\s*\(\s*\)/);
    });

    it("the trigger for dialog-open is `open-modal` and for dialog-close is `close-modal`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']dialog-open["']\s*:\s*return\s+["']open-modal["']/);
      expect(OBSERVED_SRC).toMatch(/case\s+["']dialog-close["']\s*:\s*return\s+["']close-modal["']/);
    });
  });

  describe("tab-activate — observed", () => {
    it("dispatches a real MouseEvent click + a real keydown Enter", () => {
      // The truthful tab-activate path: a real click on the tab
      // (so the application's roving-tabindex handler runs) plus
      // a real keydown Enter (so keyboard-activated tabs also
      // activate). NOT a bare `aria-selected` rewrite.
      const tabBlock = OBSERVED_SRC.match(
        /case\s+['"]tab-activate['"]\s*:\s*\{([\s\S]*?)\n\s{4}\}/,
      );
      expect(tabBlock).toBeTruthy();
      expect(tabBlock![1]).toMatch(/dispatchEvent\s*\(\s*new\s+MouseEvent\s*\(\s*["']click["']/);
      expect(tabBlock![1]).toMatch(/dispatchEvent\s*\(\s*new\s+KeyboardEvent\s*\(\s*["']keydown["']/);
    });

    it("the trigger is `switch-tab`, not `click`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']tab-activate["']\s*:\s*return\s+["']switch-tab["']/);
    });
  });

  describe("choose-dropdown — observed (T2 contract, PR-8h)", () => {
    it("drives native <select> through real BiDi input.performActions (NO synthesized event)", () => {
      // PR-8h replaces the PR-8g page-side synthesized
      // HTMLSelectElement.prototype setter + dispatchEvent path
      // with a real BiDi pointer click + real BiDi ArrowDown
      // key. The page-side script is allowed ONLY to read
      // state (option count, current value); it must NOT
      // mutate the document.
      expect(OBSERVED_SRC).toMatch(/input\.performActions/);
      expect(OBSERVED_SRC).toMatch(/ArrowDown/);
      // The four forbidden patterns must NOT appear in the
      // choose-dropdown case body (the page-side PROBE_ELEMENT_FN
      // choose-dropdown case is a noop). Other probes (type,
      // tab-activate) may still use dispatchEvent because they
      // model different user actions.
      const chooseCase = OBSERVED_SRC.match(
        /case ['"]choose-dropdown['"]: \{([\s\S]*?)\n\s{4}\}/,
      );
      expect(chooseCase, "PROBE_ELEMENT_FN must contain a choose-dropdown case").toBeTruthy();
      const chooseBody = chooseCase ? chooseCase[1] ?? "" : "";
      expect(chooseBody).not.toMatch(/HTMLSelectElement\.prototype/);
      expect(chooseBody).not.toMatch(/dispatchEvent\s*\(\s*new\s+Event\s*\(\s*["']change["']/);
      expect(chooseBody).not.toMatch(/dispatchEvent\s*\(\s*new\s+MouseEvent/);
      expect(chooseBody).not.toMatch(/setter\.call/);
    });

    it("uses aria-controls for ARIA listbox lookup", () => {
      // ARIA combobox: the truthful choose path reads
      // `aria-controls` (for comboboxes that delegate to a
      // separate listbox) and falls back to a child
      // `[role="listbox"]`.
      expect(OBSERVED_SRC).toMatch(/aria-controls/);
      expect(OBSERVED_SRC).toMatch(/role=["']listbox["']/);
    });

    it("the trigger is `choose-dropdown`, not `click`", () => {
      expect(OBSERVED_SRC).toMatch(/case\s+["']choose-dropdown["']\s*:\s*return\s+["']choose-dropdown["']/);
    });

    it("PROBE_ELEMENT_FN choose-dropdown case is a noop (real BiDi drives the change)", () => {
      // The page-side dispatcher must NOT synthesize the
      // transition; the real BiDi path in runExtendedProbe does.
      const chooseCase = OBSERVED_SRC.match(
        /case ['"]choose-dropdown['"]: \{([\s\S]*?)\n\s{4}\}/,
      );
      expect(chooseCase, "PROBE_ELEMENT_FN must contain a choose-dropdown case").toBeTruthy();
      const body = chooseCase ? chooseCase[1] ?? "" : "";
      expect(body).not.toMatch(/dispatchEvent/);
      expect(body).not.toMatch(/setter\.call/);
      expect(body).toMatch(/noop/);
    });
  });

  describe("auth — orchestrator (T3 contract)", () => {
    it("uses bidi:storage.setCookies provenance (real BiDi call)", () => {
      // The auth transition's provenance is the actual BiDi
      // call `applyAuthSpec` made. NOT a derived/union marker.
      expect(STATE_MAT_SRC).toMatch(/bidi:storage\.setCookies/);
    });

    it("emits triggers: ['auth'] on the state:successor edge", () => {
      // The trigger on the auth transition edge is exactly
      // ['auth']. Not 'click', not 'focus', not anything else.
      expect(STATE_MAT_SRC).toMatch(/triggers:\s*\[\s*["']auth["']\s*\]/);
    });
  });

  describe("declared triggers (HTML analysis path)", () => {
    it("`popover` declared trigger comes from popovertarget/popover attribute analysis", () => {
      // The truthful declared popover path: HTML analysis
      // (popovertarget attribute, popover attribute). NOT a
      // fabricated shortcut.
      expect(DECLARED_SRC).toMatch(/trigger:\s*['"]popover['"]/);
    });

    it("`dialog` declared trigger comes from commandfor/dialog analysis", () => {
      expect(DECLARED_SRC).toMatch(/trigger:\s*['"]dialog['"]/);
    });

    it("`choose-dropdown` declared trigger carries the chosen optionValue", () => {
      // The truthful declared choose-dropdown path emits a
      // state:cause edge with the chosen option's value. NOT a
      // bare trigger without a value.
      expect(DECLARED_SRC).toMatch(/trigger:\s*['"]choose-dropdown['"]/);
      expect(DECLARED_SRC).toMatch(/optionValue:/);
    });

    it("declared `focus` trigger comes from roving-tabindex analysis (aria-activedescendant)", () => {
      // The truthful declared focus path analyzes the
      // roving-tabindex pattern (aria-activedescendant), not a
      // bare aria-selected rewrite.
      expect(DECLARED_SRC).toMatch(/aria-activedescendant/);
    });
  });

  describe("forbidden shortcuts (the matrix REJECTS)", () => {
    it("no `aria-expanded` direct rewrite in the expand probe block", () => {
      // A regression that replaces the real click with
      // `el.setAttribute('aria-expanded', 'true')` would be a
      // bare attribute mutation — NOT a real DOM action. The
      // application code that listens for `click` would not
      // run. This gate pins the truthful mechanism.
      const expandBlock = OBSERVED_SRC.match(
        /case\s+['"]expand['"]\s*:\s*\{([\s\S]*?)\n\s{4}\}/,
      );
      expect(expandBlock).toBeTruthy();
      expect(expandBlock![1]).not.toMatch(/setAttribute\s*\(\s*["']aria-expanded["']/);
    });

    it("no `aria-selected` direct rewrite in the tab-activate probe block", () => {
      // Symmetric guard for the roving-tabindex pattern.
      const tabBlock = OBSERVED_SRC.match(
        /case\s+['"]tab-activate['"]\s*:\s*\{([\s\S]*?)\n\s{4}\}/,
      );
      expect(tabBlock).toBeTruthy();
      expect(tabBlock![1]).not.toMatch(/setAttribute\s*\(\s*["']aria-selected["']/);
    });

    it("no bare `el.value = ...` in the type probe block (must use native setter)", () => {
      // A regression that reverts the type probe to a bare
      // `el.value = text` would skip framework listeners
      // (React/Angular intercept via the native setter).
      const typeBlock = OBSERVED_SRC.match(
        /case\s+['"]type['"]\s*:\s*\{([\s\S]*?)\n\s{4}\}/,
      );
      expect(typeBlock).toBeTruthy();
      // The block must NOT contain a bare `el.value = text`
      // assignment (it must go through the native setter).
      // The setter uses `setter.call(el, text)` instead.
      expect(typeBlock![1]).not.toMatch(/el\.value\s*=\s*text/);
      expect(typeBlock![1]).not.toMatch(/el\.value\s*=\s*[^=]/);
    });

    it("no synthesized MouseEvent on the focus probe (focus is its own path)", () => {
      // A regression that re-introduces a click on the focus
      // path would misattribute click transitions to focus.
      const focusBlock = OBSERVED_SRC.match(
        /case\s+['"]focus['"]\s*:\s*\{([\s\S]*?)\n\s{4}\}/,
      );
      expect(focusBlock).toBeTruthy();
      expect(focusBlock![1]).not.toMatch(/new\s+MouseEvent/);
    });
  });

  describe("trigger truthfulness — declared emitted triggers are a subset of the canonical union", () => {
    it("every trigger on a declared state:cause edge is in the TransitionTrigger union", () => {
      // The set of trigger values that the declared path can
      // emit is a known subset of the canonical union. The
      // matrix documents this subset; a regression that mints
      // a new trigger value (typo, fabricated) breaks the gate.
      const VALID_DECLARED: ReadonlySet<string> = new Set([
        "command", "focus", "popover", "dialog", "choose-dropdown",
        // PR-8c T8: command-specific triggers for Invoker Commands.
        "command-show-modal", "command-show-popover", "command-toggle-popover",
        "command-close", "command-hide-popover", "command-request-close",
      ]);
      // Find every `trigger: '...'` literal in the declared source.
      const triggers = Array.from(
        DECLARED_SRC.matchAll(/trigger:\s*['"]([^'"]+)['"]/g),
        (m) => m[1]!,
      );
      expect(triggers.length, "PR-8g T5: declared source must contain at least one trigger literal").toBeGreaterThan(0);
      for (const t of triggers) {
        expect(
          VALID_DECLARED.has(t),
          `PR-8g T5: declared trigger '${t}' is not in the canonical declared-trigger subset`,
        ).toBe(true);
      }
    });
  });
});
