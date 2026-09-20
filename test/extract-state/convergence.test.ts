/**
 * PR-8d T9: declared + observed convergence through REAL extractors.
 *
 * The substrate's `graph.upsertState` has a convergence logic that unions
 * `StateEvidence[].kind` and promotes the kind to `"declared+observed"`
 * when both declared and observed evidence are present for the same
 * canonical state id. The earlier PR-8c T9 test (`state-id.test.ts`)
 * exercised that logic in isolation by calling `upsertState` twice
 * directly; this file proves the same end-to-end behavior through the
 * REAL declared + observed extractors.
 *
 * The convergence flag is a critical Layer 4 audit signal: it tells the
 * application graph consumer that the same state has been *declared* in
 * the page's HTML/APG patterns AND *observed* at runtime — meaning the
 * static analysis matches the live behavior. Without the flag through
 * real extractors, the convergence claim in PR-8c T9 is vacuous.
 *
 * The test runs `extractStateDeclared.run` followed by
 * `runObservedExtractor` on the same graph + page (mocked via
 * `ObservedPageLike` so no live BiDi is required), and asserts at
 * least one State node has `evidence.some(e => e.kind ===
 * "declared+observed")`.
 */
import { describe, it, expect, vi } from "vitest";
import { extractStateDeclared, type DeclaredRecord } from "../../src/extract-state/declared.js";
import { runObservedExtractor, type ObservedPageLike, type RichSnapshot, type RichElementObservation } from "../../src/extract-state/observed.js";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode, AuthContext, NetworkContext } from "../../src/graph/types.js";

const PAGE = "page:https://example.com/";
const PAGE_URL = "https://example.com/";

function makePageNode(): PageNode {
  return {
    id: PAGE,
    type: "page",
    url: "https://example.com/",
    title: "T",
    discoveredVia: ["seed"],
    loadStatus: "complete",
    axTreeRef: { rootAxId: `ax:${PAGE}:root`, provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null,
    screenshotRef: null,
    canonicalUrl: "https://example.com/",
    crawledAt: "2026-08-30T00:00:00.000Z",
    parentPageId: null,
  };
}

/**
 * Seed the graph with the structural AxNodes the structural extractor
 * would have written: a button (source) and a dialog (target). The
 * declared extractor's `buildBaselineSnapshot` iterates these nodes to
 * build the pre-transition `MaterializeSnapshot`, so they must be in
 * the graph before convergence can fire.
 */
function seedAxNodes(g: Graph, sourceAxId: string, targetAxId: string): void {
  g.upsertPage(makePageNode());
  g.upsertAx({
    id: targetAxId, type: "ax-node", pageId: PAGE,
    role: "dialog", name: "Sign-in dialog", nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 1, parentAxId: null, provenance: "aria:t",
  });
  g.upsertAx({
    id: sourceAxId, type: "ax-node", pageId: PAGE,
    role: "button", name: "Sign in", nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
  });
}

/**
 * Build a baseline `RichSnapshot` (the "before" view of the page) that
 * matches what `axNodeToObservation` (declared.ts) and the page-side
 * walker (observed.ts) would both produce. When this exact snapshot is
 * returned by the observed mock AND the declared path's baseline is
 * derived from the same AxNodes, the two paths' canonical state id is
 * the same, and the convergence flag fires.
 *
 * The two-element map below is the minimal set: the source button
 * (always present) and the target dialog (also always present). The
 * `openDialogIds` and `openPopoverIds` arrays drive the after-state
 * divergence — the button click should add the dialog to
 * `openDialogIds` (the `command=show-modal` semantics).
 */
function baselineRichSnap(sourceAxId: string, targetAxId: string): RichSnapshot {
  const element = (axId: string, overrides: Partial<RichElementObservation> = {}): RichElementObservation => ({
    axId,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    visibility: "visible",
    zIndex: 0,
    open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
    // PR-8g T1: per-element focus flag. The baseline test page
    // has no element focused (activeElement is <body>).
    focused: false,
    ariaStates: {},
    visualNodeId: null,
    conditionalMarkers: {},
    ...overrides,
  });
  return {
    hash: "h:baseline",
    // The observed snapshot must include the SAME set of elements
    // the declared path materializes (all AxNodes on the page, per
    // `buildBaselineSnapshot`). Otherwise the canonical payload's
    // `elements` map differs and the two paths produce different
    // state ids — no convergence.
    elements: [element(sourceAxId), element(targetAxId)],
    openDialogIds: [],
    openPopoverIds: [],
    expandedRegionAxIds: [],
    viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
    online: true,
    conditionalMarkers: {},
    // PR-8g T1: State-level focus pointer. Default: no element
    // focused. Tests that exercise focus set this field directly.
    focusedAxId: null,
  };
}

/**
 * After-snapshot: the click was performed, the dialog opened. The
 * declared path arrives at the SAME state (target added to
 * `openDialogIds`) because `command=show-modal` is the command value
 * the declared extractor carries through `deriveAfterSnapshot`.
 */
function afterRichSnap(sourceAxId: string, targetAxId: string): RichSnapshot {
  return {
    ...baselineRichSnap(sourceAxId, targetAxId),
    hash: "h:after",
    openDialogIds: [targetAxId],
  };
}

/**
 * Build an `ObservedPageLike` whose `script.callFunction`:
 *   - returns the declared record (for the declared extractor)
 *   - returns the rich snapshot pair (for the observed probe loop)
 *   - returns the post-click interactive element list (for the
 *     probe loop's `listInteractiveElements`)
 *
 * The call sequence is driven by the callFunction queue. Both
 * extractors share the same page object so the test exercises the
 * real `extractStateDeclared.run` → `runObservedExtractor` sequence.
 */
function makeObservedPage(
  sourceAxId: string,
  targetAxId: string,
  declaredRecords: DeclaredRecord[],
): ObservedPageLike {
  const snap = {
    baseline: baselineRichSnap(sourceAxId, targetAxId),
    after: afterRichSnap(sourceAxId, targetAxId),
  };
  let phase: "declared" | "observed" = "declared";
  let callIndex = 0;
  const callFunction = vi.fn(async (_target: any, _src: any, _args: any): Promise<any> => {
    if (phase === "declared") {
      return declaredRecords;
    }
    // Observed probe loop sequence:
    //   call 1: takeRichSnapshot (pre-baseline)
    //   call 2: listInteractiveElements
    //   call 3: takeRichSnapshot (probe baseline)
    //   call 4: takeRichSnapshot (probe before)
    //   call 5: takeRichSnapshot (probe after)
    callIndex++;
    if (callIndex === 2) {
      return [{
        axId: sourceAxId,
        role: "button",
        tagName: "button",
        rect: { x: 0, y: 0, w: 0, h: 0 },
        visible: true,
        textContent: "Sign in",
        apgKind: "commandfor",
        hasStateCause: true,
      }];
    }
    if (callIndex <= 4) return snap.baseline;
    return snap.after;
  });
  const page: ObservedPageLike = {
    target: { context: "ctx-test" } as any,
    script: { callFunction: callFunction as any, evaluate: vi.fn() },
    input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
  };
  return Object.assign(page, {
    /** Internal hook used by the test to switch the mock into observed mode. */
    __switchToObserved: () => { phase = "observed"; callIndex = 0; },
  });
}

describe("PR-8d T9: declared + observed convergence through real extractors", () => {
  it("promotes a State node's evidence to 'declared+observed' when the same state is reached by both extractors", async () => {
    const sourceAxId = "ax:page:btn-signin";
    const targetAxId = "ax:page:signin-dlg";
    const records: DeclaredRecord[] = [{
      fromAxId: sourceAxId, toAxId: targetAxId,
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-show-modal", commandValue: "show-modal",
    }];

    const g = new Graph();
    seedAxNodes(g, sourceAxId, targetAxId);

    // The declared extractor needs the declared record to land in the
    // graph. The observed mock below returns it on the first call.
    const page = makeObservedPage(sourceAxId, targetAxId, records) as ObservedPageLike & {
      __switchToObserved: () => void;
    };

    // ---- Pass 1: declared extractor ----
    await extractStateDeclared.run({
      graph: g,
      page: page as any,
      pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });

    const statesAfterDeclared = Array.from(g.states());
    expect(statesAfterDeclared.length).toBeGreaterThan(0);
    // The declared path must have produced at least one state with
    // declared evidence. The convergence flag itself has not fired
    // yet — observed hasn't run.
    const anyDeclaredOnly = statesAfterDeclared.some((s) =>
      s.evidence.some((e) => e.kind === "declared") &&
      !s.evidence.some((e) => e.kind === "observed"),
    );
    expect(anyDeclaredOnly).toBe(true);
    expect(statesAfterDeclared.every((s) => !s.evidence.some((e) => e.kind === "declared+observed"))).toBe(true);

    // ---- Pass 2: observed extractor ----
    page.__switchToObserved();
    const r = await runObservedExtractor(g, page, PAGE, () => undefined);
    expect(r.produced).toBe(true);

    // ---- Convergence assertion ----
    // After both extractors run, at least one State node must have the
    // promoted evidence kind. The convergence logic in `upsertState`
    // unions declared + observed evidence and renames plain kinds to
    // "declared+observed" when both are present.
    const allStates = Array.from(g.states());
    const converged = allStates.filter((s) =>
      s.evidence.some((e) => e.kind === "declared+observed"),
    );
    expect(converged.length).toBeGreaterThan(0);
    // The converged state's payload must be the "dialog open" state
    // (the one both extractors reached). The target dialog must be
    // in `openDialogIds` (command=show-modal semantics).
    const dialogState = converged.find((s) =>
      s.payload.openDialogIds.includes(targetAxId),
    );
    expect(dialogState).toBeDefined();
  });

  it("convergence is reachable through a popovertarget (popover-open after-state)", async () => {
    // Same convergence surface as the first test, but with a
    // popovertarget edge kind and `command=show-popover` so the
    // after-state is "popover open" rather than "dialog open".
    // This proves convergence is not specific to one edge kind.
    const sourceAxId = "ax:page:btn-settings";
    const targetAxId = "ax:page:settings-panel";
    const records: DeclaredRecord[] = [{
      fromAxId: sourceAxId, toAxId: targetAxId,
      kind: "popovertarget", transitionKind: "declared",
      trigger: "command-show-popover", commandValue: "show-popover",
    }];

    const g = new Graph();
    // Re-seed the target as a region (popover semantics, not dialog).
    g.upsertPage(makePageNode());
    g.upsertAx({
      id: targetAxId, type: "ax-node", pageId: PAGE,
      role: "region", name: "Settings panel", nameSource: "aria-label",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 1, parentAxId: null, provenance: "aria:t",
    });
    g.upsertAx({
      id: sourceAxId, type: "ax-node", pageId: PAGE,
      role: "button", name: "Settings", nameSource: "content",
      states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
      properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
      apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
    });

    // Pass 1: declared (popovertarget with command=show-popover)
    const declaredPage = makeObservedPage(sourceAxId, targetAxId, records) as ObservedPageLike & {
      __switchToObserved: () => void;
    };
    await extractStateDeclared.run({
      graph: g,
      page: declaredPage as any,
      pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });

    // Pass 2: observed — same canonical payload (popover open). Build
    // a fresh page mock that returns the popover-open after.
    const popoverSnap: RichSnapshot = {
      ...baselineRichSnap(sourceAxId, targetAxId),
      hash: "h:popover-after",
      openPopoverIds: [targetAxId],
    };
    let observedCallIdx = 0;
    const observedPage: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: {
        callFunction: (async () => {
          observedCallIdx++;
          if (observedCallIdx === 2) return [{
            axId: sourceAxId, role: "button", tagName: "button",
            rect: { x: 0, y: 0, w: 0, h: 0 },
            visible: true, textContent: "Settings", apgKind: "popovertarget", hasStateCause: true,
          }];
          if (observedCallIdx <= 4) return baselineRichSnap(sourceAxId, targetAxId);
          return popoverSnap;
        }) as any,
        evaluate: vi.fn(),
      },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    const r = await runObservedExtractor(g, observedPage, PAGE, () => undefined);
    expect(r.produced).toBe(true);

    const converged = Array.from(g.states()).filter((s) =>
      s.evidence.some((e) => e.kind === "declared+observed"),
    );
    expect(converged.length).toBeGreaterThan(0);
    // The popover-open after-state must be one of the converged states.
    const popoverState = converged.find((s) =>
      s.payload.openPopoverIds.includes(targetAxId),
    );
    expect(popoverState).toBeDefined();
  });

  it("does NOT set the convergence flag on the AFTER-state when the observed after-state diverges from the declared after-state (different payload)", async () => {
    // The negative case: declared says dialog open, observed says
    // popover open on the same page. Different `openDialogIds` vs
    // `openPopoverIds` → different canonical payload for the
    // after-state → different state id for the after-state →
    // the AFTER-state itself must NOT have the convergence flag.
    //
    // (The pre-probe baseline state will always converge — both
    // paths see the same initial page. This test asserts only on
    // the after-state.)
    const sourceAxId = "ax:page:btn-x";
    const targetAxId = "ax:page:target-y";
    const records: DeclaredRecord[] = [{
      fromAxId: sourceAxId, toAxId: targetAxId,
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-show-modal", commandValue: "show-modal",
    }];

    const g = new Graph();
    seedAxNodes(g, sourceAxId, targetAxId);

    // Pass 1: declared says dialog open.
    const declaredPage = makeObservedPage(sourceAxId, targetAxId, records) as ObservedPageLike & {
      __switchToObserved: () => void;
    };
    await extractStateDeclared.run({
      graph: g,
      page: declaredPage as any,
      pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });

    // The declared "after" state has the dialog in openDialogIds.
    const declaredAfter = Array.from(g.states()).find((s) =>
      s.payload.openDialogIds.includes(targetAxId),
    );
    expect(declaredAfter).toBeDefined();

    // Pass 2: observed — return a popover-open after state (different
    // canonical payload). The popover after-state must be a NEW
    // state, not the same id as the declared after-state.
    let callIdx = 0;
    const popoverSnap: RichSnapshot = {
      ...baselineRichSnap(sourceAxId, targetAxId),
      hash: "h:popover",
      openPopoverIds: [targetAxId], // different from declared's openDialogIds
    };
    const observedPage: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: {
        callFunction: (async () => {
          callIdx++;
          if (callIdx === 2) return [{
            axId: sourceAxId, role: "button", tagName: "button",
            rect: { x: 0, y: 0, w: 0, h: 0 },
            visible: true, textContent: "x", apgKind: "commandfor", hasStateCause: true,
          }];
          if (callIdx <= 4) return baselineRichSnap(sourceAxId, targetAxId);
          return popoverSnap;
        }) as any,
        evaluate: vi.fn(),
      },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    await runObservedExtractor(g, observedPage, PAGE, () => undefined);

    // The declared after-state and the observed after-state must be
    // different state ids. The convergence flag is per-state, not
    // graph-wide: the declared after-state has only `declared`
    // evidence (no observed matching id), the observed popover
    // after-state has only `observed` evidence.
    const convergedDeclaredAfter = declaredAfter!.evidence.some(
      (e) => e.kind === "declared+observed",
    );
    expect(convergedDeclaredAfter).toBe(false);
    // There should be a separate popover-open state, observed-only.
    const observedPopoverState = Array.from(g.states()).find((s) =>
      s.payload.openPopoverIds.includes(targetAxId),
    );
    expect(observedPopoverState).toBeDefined();
    expect(observedPopoverState!.id).not.toBe(declaredAfter!.id);
    // The observed popover state has only `observed` evidence
    // (not the convergence flag — the declared path never visited
    // the popover-open state, so there's no declared evidence to
    // union with).
    const popoverHasDeclared = observedPopoverState!.evidence.some(
      (e) => e.kind === "declared" || e.kind === "declared+observed",
    );
    expect(popoverHasDeclared).toBe(false);
  });
});
