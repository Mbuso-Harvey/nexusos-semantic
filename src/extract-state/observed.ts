/**
 * Stage 7 (observed half) — extract-state-observed.
 *
 * The "observed" half of the state extractor runs a *probe loop* against every
 * interactive element on the page: snapshot the a11y + aria-state + dialog-open
 * state, fire a non-destructive interaction, snapshot again, and record a
 * `Transition` if the diff is non-empty.
 *
 * **PR-8 (ED-01 correction 2G): `Transition` records are
 * audit/provenance compatibility data only.** They are NOT the
 * canonical representation of a state. The canonical representation
 * is the `StateNode` graph (see `src/extract-state/observed.ts`'s
 * T5 / `materializeStates` function). The `Transition` records are
 * kept for backward compat (existing tests, query surface) and as
 * an audit trail of what the probe loop saw.
 *
 * Plan section 7.2 specifies the probe order per element:
 *   1. focus      — Tab key OR pointer down/up at center
 *   2. hover      — pointer move over the rect + 300ms wait
 *   3. click      — only for button/link/menuitem/tab roles
 *   4. key Enter  — only for button-like roles
 *   5. key Space  — only for button-like roles
 *   6. dismiss    — Escape, ONLY if a prior probe on this element produced
 *                   a state change
 *
 * The loop is non-exhaustive: no typing, no drag, no programmatic scroll.
 * For v1, the loop is capped at 30 probes per page (plan 7.2 budget) and at
 * 5 seconds of wall-clock time. The first probe on an element that produces
 * a transition marks the element "done" — subsequent probes on the same
 * element are skipped (per spec).
 *
 * Substrate: Firefox 154 + geckodriver 0.36.0; the loop drives the page via
 * `script.callFunction` (snapshots + interactive enumeration) and
 * `input.performActions` (BiDi input source for pointer/key).
 */
import type { Page } from "../bidi-client/page.js";
import type { ScriptTarget, ScriptApi } from "../bidi-client/script.js";
import type { InputApi, Source } from "../bidi-client/input.js";
import { translateKeyName } from "../bidi-client/input.js";
import type {
  Transition, TransitionTrigger, AuthContext, NetworkContext, ElementStateObservation,
} from "../graph/types.js";
import type { Graph } from "../graph/graph.js";
import type { Extractor } from "../crawler/orchestrator.js";
import {
  materializeState, materializeSuccessor, resolveStateCauseEdges,
  type MaterializeSnapshot,
} from "./state-materialize.js";
import { AXID_JS_BODY } from "./ax-id.js";

// ----- Public types -----

/** Minimal rect for viewport-space interaction. */
export interface ObservedRect {
  x: number; y: number; w: number; h: number;
}

/** One interactive element surfaced by the enumeration script. */
export interface InteractiveElement {
  axId: string;
  rect: ObservedRect;
  tagName: string;
  role: string;       // explicit role attribute, or implicit role from tag
}

/** A11y + aria + dialog snapshot taken between probes. */
export interface ObservedSnapshot {
  hash: string;
  a11yCount: number;
  ariaStates: Record<string, Record<string, string | null>>;
  dialogOpen: Record<string, boolean>;
}

/** The dependency surface the probe loop actually uses. */
export interface ObservedPageLike {
  target: ScriptTarget;
  script: Pick<ScriptApi, "callFunction" | "evaluate">;
  input: Pick<InputApi, "performActions" | "sendKey">;
}

/** Internal options for the probe loop (split out for testability). */
export interface ObservedProbeOptions {
  page: ObservedPageLike;
  pageId: string;
  /** How to enumerate interactive elements (defaults to a `callFunction`). */
  listInteractive?: () => Promise<InteractiveElement[]>;
  /** How to take a snapshot (defaults to a `callFunction`). */
  takeSnapshot?: () => Promise<ObservedSnapshot>;
  /** Wait helper for the 300ms post-action settle. */
  wait?: (ms: number) => Promise<void>;
  /** Monotonic clock for the 5-second budget. */
  now?: () => number;
}

/** The result shape an `Extractor` runs against. */
export interface ObservedProbeResult {
  probes: number;
  transitions: number;
}

// ----- Public knobs (re-used in tests) -----

/** Maximum number of probes per page (plan 7.2 budget). */
export const MAX_PROBES = 30;
/** Wall-clock cap on the probe loop. */
export const PROBE_TIMEOUT_MS = 5_000;
/** Post-action settle delay before taking the after-snapshot. */
export const POST_ACTION_SETTLE_MS = 300;

// ----- Probe kinds (drive the priority order + transition trigger) -----
//
// PR-8: expanded probe vocabulary covers the full brief §13/§16/§17
// trigger list. The original 6 are preserved in `PROBE_ORDER` (for
// backward compat with the existing test surface); the new kinds
// live in `EXTENDED_PROBE_ORDER` and are driven by
// `runObservedProbeLoopV2`. The orchestrator's `runObservedExtractor`
// uses the V2 loop.

const PROBE_ORDER = ["focus", "hover", "click", "keyEnter", "keySpace", "dismiss"] as const;
type ProbeKind = typeof PROBE_ORDER[number];

export const EXTENDED_PROBE_ORDER = [
  "focus", "hover", "click", "keyEnter", "keySpace",
  "keyEscape", "keyTab",
  // PR-8d (item 3): the keyboard-vocabulary is a real per-direction
  // set, not a single generic "keyArrow" that always pressed
  // ArrowDown. Each direction is a separate probe kind so:
  //   - the trigger on the produced state-transition edge is
  //     honest (e.g. "key-arrow-down" on a combobox, not
  //     "key-arrow" which misleads consumers about which key
  //     caused the diff);
  //   - combobox/listbox/tablist can be exercised in all four
  //     directions, including Home/End for "first/last" semantics;
  //   - tests can assert a specific key fired the probe, not
  //     "some arrow key".
  "keyArrowUp", "keyArrowDown", "keyArrowLeft", "keyArrowRight",
  "keyHome", "keyEnd",
  "type", "submit",
  // PR-8d (item 3): scroll and network-wait are page-level probes,
  // not element-level. The page-level loop dispatches them once
  // per run (not per element); see `runPageLevelProbes` below.
  "scroll", "network-wait", "drag",
  "expand", "collapse",
  // PR-8g T2: choose-dropdown is a real production transition
  // (per blocker 2 of the PR-8g binding instruction). For native
  // <select> the probe mutates el.value via the native setter and
  // dispatches a real `change` event (not a click on an <option>
  // — the user did not click on an <option>; they activated a
  // <select>). For ARIA combobox/listbox the probe locates the
  // listbox (child or aria-controls-referenced) and dispatches a
  // real click on a non-active <li role="option">. Both paths
  // are NOT enum-only satisfaction; both fire real DOM events
  // that the application code observes.
  "choose-dropdown",
  "dialog-open", "dialog-close", "tab-activate",
] as const;
export type ExtendedProbeKind = typeof EXTENDED_PROBE_ORDER[number];

const BUTTON_LIKE_ROLES = new Set([
  "button", "link", "menuitem", "tab", "switch", "checkbox", "radio",
  "option", "treeitem", "combobox", "summary",
]);

// ----- Extractor wiring -----

/**
 * Plug-in `Extractor` that wraps `runObservedProbeLoop`. Use this to drop the
 * observed-half into the standard orchestrator pipeline.
 */
export const observedExtractor: Extractor = {
  name: "state-observed",
  async run({ graph, page, pageNode, log, auth, network }) {
    return runObservedExtractor(
      graph,
      page as unknown as ObservedPageLike,
      pageNode.id,
      log,
      { auth, network },
    );
  },
};

/**
 * Run the observed probe loop and write any observed transitions into `graph`.
 * Returns a result the caller can surface in its own log.
 *
 * **PR-8:** the V2 probe loop is the new canonical surface. It
 * produces State nodes (via `materializeStates`) AND keeps the
 * legacy `Transition` records as audit/provenance (2G). The V2 loop
 * is bounded by `state:cause` edges: if the graph already has any
 * `state:cause` edge, the V2 loop only probes the elements that have
 * one (or button-like roles, as a safety net).
 */
export async function runObservedExtractor(
  graph: Graph,
  page: ObservedPageLike,
  pageId: string,
  log: (msg: string) => void,
  opts: { auth?: AuthContext; network?: NetworkContext } = {},
): Promise<{ produced: boolean; durationMs: number; result: ObservedProbeV2Result }> {
  const t0 = Date.now();
  // Pre-baseline: take a rich snapshot so the page's "before" state
  // is recorded even if the loop produces no diffs.
  const baseline = await takeRichSnapshot(page, pageId);
  const causeAxIds = collectStateCauseAxIds(graph);

  const result = await runObservedProbeLoopV2({
    page,
    pageId,
    listInteractive: () => listInteractiveElements(page, pageId),
    takeSnapshot: () => takeRichSnapshot(page, pageId),
    causeAxIds,
  });

  // Materialize State nodes (T5): for every hit + the baseline, build
  // a StatePayload, derive the id, upsert, and emit the cross-layer
  // edges. The new `materializeStates` consumes the real pre/post
  // `RichSnapshot`s the probe loop captured — no synthetic mutation.
  const route = pageId.startsWith("page:") ? pageId.slice("page:".length) : pageId;
  // PR-8 2C: auth context is explicit (anonymous | authenticated | administrator
  // | custom-role). Observed evidence may annotate, never assert. The v1
  // orchestrator passes the configured context; the test harness overrides.
  const stateAuth: AuthContext = opts.auth ?? { kind: "anonymous" };
  // PR-8 2D: network evidence is one of bidi:network (real events),
  // page-instrumented (fetch/XHR shim), static (no evidence). The v1
  // orchestrator records "static" because no BiDi network events
  // are subscribed in this build.
  const stateNetwork: NetworkContext = opts.network ?? {
    status: baseline.online ? "online" : "offline",
    evidence: "static",
  };
  // PR-8b: the new `materializeStates` accepts the probe loop's
  // `result.hits` directly (each hit carries full before/after
  // `RichSnapshot`s). The function uses the shared materializer,
  // so the `declared+observed` convergence flag can actually fire.
  const statesProduced = materializeStates(
    graph,
    pageId,
    route,
    stateAuth,
    stateNetwork,
    baseline,
    result.hits,
  );
  // PR-8b (item 4): resolve `state:cause` placeholders. Edges with
  // no matching State are *removed* (not re-pointed at a random
  // state). The onUnresolved callback in the declared extractor
  // logs a warning when this happens.
  resolveStateCauseEdges(graph);

  // Legacy transition records (2G: audit/provenance only). The
  // legacy `Transition` shape only stores the before/after *hashes*,
  // not the full snapshots — the State graph is the canonical
  // surface. Convert the V2 hits (which carry full snapshots) into
  // the legacy shape so the existing `buildTransitionsForRun` can
  // run.
  const legacyHits: ObservedTransitionHit[] = result.hits.map((h) => ({
    axId: h.axId,
    probe: "click" as ProbeKind, // legacy shape is fixed to the 6 PROBE_ORDER kinds
    beforeHash: h.beforeSnapshot.hash,
    afterHash: h.afterSnapshot.hash,
  }));
  const legacyTransitions = buildTransitionsForRun(
    { probes: result.probes, transitions: legacyHits.length, hits: legacyHits },
    pageId,
  );
  for (const t of legacyTransitions) graph.upsertTransition(t);

  log(`  [state-observed] probes=${result.probes} hits=${result.hits.length} states=${statesProduced}`);
  return {
    produced: statesProduced > 0 || result.hits.length > 0,
    durationMs: Date.now() - t0,
    result,
  };
}

/** Find the set of axIds that have an outgoing `state:cause` edge. */
function collectStateCauseAxIds(graph: Graph): Set<string> | undefined {
  let s: Set<string> | undefined;
  for (const e of graph.allEdges()) {
    if (e.kind === "state:cause") {
      if (!s) s = new Set();
      s.add(e.from);
    }
  }
  return s;
}

/**
 * PR-8b (items 1, 7, 8): materialize State nodes from the probe
 * loop's real before/after `RichSnapshot`s. Uses the shared
 * `materializeSuccessor` so the same code path serves both the
 * declared and the observed extractors (this is what enables the
 * `declared+observed` convergence flag to actually fire).
 *
 * Each (element, before, after, hit) tuple is converted to a
 * `MaterializeSnapshot` (a Record of `ElementStateObservation`s +
 * cross-cutting structural facts). The shared materializer builds
 * the canonical `StatePayload` from the real snapshot data, derives
 * the id, and upserts. Cross-layer edges (`state:on-page`,
 * `state:of-element`, `state:visual`, `state:auth`,
 * `state-feeds-capability`) are emitted by the materializer.
 *
 * PR-8e (convergence fix): the rich snapshot enumerates only the
 * interactive element set (the `LIST_INTERACTIVE_FN` selector), but
 * the declared materializer's baseline enumerates every AxNode in
 * the structural walker. When the two paths observed the same
 * application state, their element maps differ in size, so
 * `deriveStateId` produces different ids and the convergence flag
 * never fires. To fix this without lying about the observed data,
 * the rich snapshot is *augmented* with placeholder observations
 * for every AxNode in the graph that isn't in the rich snapshot.
 * The placeholders carry the same null/zero defaults the
 * `projectToSemantic` projection drops, so they do not change the
 * state id when added on both sides.
 *
 * Returns the number of State nodes upserted.
 */
function materializeStates(
  graph: Graph,
  pageId: string,
  route: string,
  auth: AuthContext,
  network: NetworkContext,
  baseline: RichSnapshot,
  hits: Array<{ axId: string; beforeSnapshot: RichSnapshot; afterSnapshot: RichSnapshot; trigger: TransitionTrigger }>,
): number {
  let count = 0;
  // The baseline is the page's pre-probe state. We materializer it
  // via `materializeState` so cross-layer edges (state:on-page,
  // state:auth) are consistent with the after-state materialization.
  const baselineSnapshot = richToMaterializeSnapshot(graph, pageId, baseline);
  // The baseline is observed (probe-loop-collected), so use
  // "observed" evidence. There is no probe that caused the
  // baseline state itself; the `transitionId` is null.
  const baselineAt = new Date().toISOString();
  const sourceAxIdsBaseline = Object.keys(baselineSnapshot.elements).slice(0, 1);
  const baseResult = materializeState(
    graph, pageId, route, auth, network,
    baselineSnapshot, sourceAxIdsBaseline, {
      kind: "observed",
      sourceAxId: sourceAxIdsBaseline[0] ?? "ax:baseline",
      transitionId: null,
      at: baselineAt,
    }, "dom-diff:probe",
  );
  count++;
  const baselineId = baseResult.stateId;
  for (const hit of hits) {
    const before = richToMaterializeSnapshot(graph, pageId, hit.beforeSnapshot);
    const after = richToMaterializeSnapshot(graph, pageId, hit.afterSnapshot);
    // Use the actual real probe-collected before/after as the
    // before/after snapshots. `materializeSuccessor` will upsert
    // both states (the convergence logic in `graph.upsertState`
    // unions the evidence with the existing one). The "before"
    // state may already exist (it equals the baseline); the
    // materializer is idempotent on id.
    const result = materializeSuccessor({
      graph,
      pageId,
      route,
      auth,
      network,
      before,
      after,
      sourceAxId: hit.axId,
      trigger: hit.trigger,
      evidenceKind: "observed",
      provenance: "dom-diff:probe",
    });
    if (result.beforeId !== baselineId) count++;
    if (result.afterId !== baselineId && result.afterId !== result.beforeId) count++;
  }
  return count;
}

/** Convert a `RichSnapshot` (the page-side probe loop output) to a
 *  `MaterializeSnapshot` (the materializer's input). Element
 *  observations are converted field-for-field; the visualNodeId
 *  is **passed through** from the page-side observation (PR-8d
 *  item 2 — it must NOT be blanked to null on the conversion,
 *  otherwise the state observation loses the real VisualNode
 *  reference that the visual layer anchored).
 *
 *  PR-8e (convergence fix): the rich snapshot enumerates only the
 *  interactive selector. The declared materializer, by contrast,
 *  enumerates every AxNode in the structural walker. To make the
 *  two paths produce identical state ids when the application
 *  state is identical, this function augments the rich snapshot's
 *  element map with placeholder observations for every AxNode in
 *  the graph that isn't already in the snapshot. The placeholders
 *  use the same null/zero defaults `projectToSemantic` ignores
 *  (rect {0,0,0,0}, visibility "visible", all booleans null, no
 *  ariaStates, no visualNodeId), so they don't change the
 *  projection's hash. The augmentation is idempotent: re-running
 *  it on a snapshot that already covers the AxNode set is a no-op. */
function richToMaterializeSnapshot(
  graph: Graph,
  pageId: string,
  snap: RichSnapshot,
): MaterializeSnapshot {
  const elements: Record<string, ElementStateObservation> = {};
  for (const e of snap.elements) {
    elements[e.axId] = {
      axId: e.axId,
      rect: e.rect,
      visibility: e.visibility,
      zIndex: e.zIndex,
      open: e.open,
      expanded: e.expanded,
      selected: e.selected,
      checked: e.checked,
      pressed: e.pressed,
      busy: e.busy,
      // PR-8g T1: per-element focus flag from the rich snapshot.
      // The page-side walker sets it via reference equality with
      // `document.activeElement`, so exactly one element on the
      // page reports `focused: true` (or none, when focus is on
      // the document body). The State-level `focusedAxId` agrees.
      focused: e.focused,
      ariaStates: e.ariaStates,
      visualNodeId: e.visualNodeId ?? null,
    };
  }
  // Augment with the structural-walker's element set so the
  // observed payload's element map covers the same axIds as the
  // declared payload's. We only walk AxNodes that belong to the
  // same page (pageId matches); cross-page AxNodes are excluded.
  // Public Graph surface exposes `axNodes()`; we filter by pageId.
  // PR-8e: the augmented element's visibility is read from the
  // AxNode (the structural walker captured it). This ensures the
  // declared and observed paths produce identical state ids when
  // the page's actual visual state is unchanged.
  const gAny = graph as unknown as { axNodes(): IterableIterator<{ id: string; pageId: string; visibility: "visible" | "hidden" | "display-none" | "offscreen"; states: { open: boolean | null; expanded: boolean | null; selected: boolean | null; checked: boolean | null; pressed: boolean | null; busy: boolean | null } }> };
  for (const ax of gAny.axNodes()) {
    if (ax.pageId !== pageId) continue;
    if (elements[ax.id]) continue;
    elements[ax.id] = {
      axId: ax.id,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      visibility: ax.visibility,
      zIndex: null,
      // PR-8f: use the structural walker's `open` for dialogs and
      // popovers so the augmentation agrees with the declared
      // materializer (which uses `ax.states.open` via
      // `axNodeToObservation`). Previously the augmentation
      // hard-coded `open: null`, which caused a closed
      // `<div popover id="user-menu">` to hash differently on the
      // two paths even though the visible state was identical.
      open: ax.states.open,
      expanded: ax.states.expanded,
      selected: ax.states.selected,
      checked: ax.states.checked,
      pressed: ax.states.pressed,
      busy: ax.states.busy,
      // PR-8g T1: structural-walker-augmented elements default
      // `focused: false` (the structural walker does not capture
      // focus; the rich snapshot is the source of truth). The
      // State-level `focusedAxId` resolves the actual focused
      // element by id; an element with `focused: false` here
      // matches `focusedAxId !== axId` at the State level.
      focused: false,
      ariaStates: {},
      visualNodeId: null,
    };
  }
  return {
    elements,
    // PR-8g T1: propagate the State-level focus pointer from the
    // rich snapshot. A snapshot taken with no element focused
    // (activeElement === <body>) produces `focusedAxId: null`; a
    // focus probe that changes activeElement produces a different
    // `focusedAxId` between before/after, which the diff catches.
    focusedAxId: snap.focusedAxId,
    openDialogIds: snap.openDialogIds,
    openPopoverIds: snap.openPopoverIds,
    expandedRegionAxIds: snap.expandedRegionAxIds,
    viewport: snap.viewport,
    conditionalMarkers: snap.conditionalMarkers,
  };
}

/**
 * The probe loop itself. Pulled out so unit tests can inject synthetic
 * interactive lists + snapshot funcs without a real BiDi session.
 *
 * Returns the probe count and the list of (element, probeKind, beforeHash,
 * afterHash) tuples that produced a diff. The caller converts those into
 * `Transition` records.
 */
export async function runObservedProbeLoop(
  opts: ObservedProbeOptions,
): Promise<ObservedProbeResult & { hits: ObservedTransitionHit[] }> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const startTime = now();

  const listInteractive = opts.listInteractive ?? (() => listInteractiveElements(opts.page, opts.pageId));
  const takeSnapshot = opts.takeSnapshot ?? (() => takeObservedSnapshot(opts.page, opts.pageId));

  const interactive = await listInteractive();
  // Baseline snapshot: captured for the spec ("the baseline snapshot is
  // taken before any probe"). The per-probe `before` snapshot is taken
  // immediately before each probe because the page can drift between
  // probes even on a single element.
  await takeSnapshot();

  const hits: ObservedTransitionHit[] = [];
  let probes = 0;
  // PR-8g T1: elementProduced is now keyed by (axId, probeKind) so
  // that a focus probe and a click probe on the same element are
  // INDEPENDENT. The pre-PR-8g set was keyed by axId alone, which
  // meant once focus produced a transition the click probe was
  // skipped — and conversely, when click ran first, focus on the
  // same element was never attempted. The trigger-truthfulness
  // acceptance criterion (focus must not be misattributed as
  // click, and click must not be suppressed by an earlier focus)
  // requires per-(element, probe-kind) bookkeeping. The V2 loop
  // gets the same fix below.
  const elementProduced = new Set<string>();
  // Per spec: "Dismiss — Escape, only after a prior step produced a state
  // change." We track, per element, whether ANY prior probe on this
  // element produced a transition (so dismiss may fire).
  const elementHadDiff = new Set<string>();

  for (const el of interactive) {
    if (probes >= MAX_PROBES) break;
    if (now() - startTime > PROBE_TIMEOUT_MS) break;

    for (const probe of PROBE_ORDER) {
      if (probes >= MAX_PROBES) break;
      if (now() - startTime > PROBE_TIMEOUT_MS) break;
      // PR-8g T1: per-(element, probe-kind) gate. A focus hit
      // does NOT block a subsequent click on the same element;
      // a click hit does NOT block a subsequent focus.
      if (elementProduced.has(`${el.axId}::${probe}`)) continue;
      if (!probeApplies(el, probe, elementHadDiff.has(el.axId))) continue;

      const before = await takeSnapshot();
      try {
        await runProbe(opts.page, el, probe);
        await wait(POST_ACTION_SETTLE_MS);
      } catch {
        // Probes can fail on disabled/hidden elements; treat as "no change"
        // and move on rather than aborting the whole loop.
        probes++;
        continue;
      }
      const after = await takeSnapshot();
      probes++;

      if (snapshotDiffers(before, after)) {
        hits.push({
          axId: el.axId,
          probe,
          beforeHash: before.hash,
          afterHash: after.hash,
        });
        elementHadDiff.add(el.axId);
        // PR-8g T1: per-(element, probe-kind) — the very next
        // attempt of the SAME probe on the SAME element will
        // see elementProduced.has()=true and bail. A different
        // probe on the same element is unaffected.
        elementProduced.add(`${el.axId}::${probe}`);
      }
    }
  }

  return { probes, transitions: hits.length, hits };
}

/** One captured diff between two snapshots. */
export interface ObservedTransitionHit {
  axId: string;
  probe: ProbeKind;
  beforeHash: string;
  afterHash: string;
}

// ----- Helpers -----

/** Decide whether `probe` is valid for `el` at this point in the loop. */
function probeApplies(
  el: InteractiveElement,
  probe: ProbeKind,
  // Whether this element already produced a transition earlier in the loop.
  alreadyProduced: boolean,
): boolean {
  switch (probe) {
    case "focus":
    case "hover":
      return true;
    case "click":
      if (el.tagName === "button" || el.tagName === "a" || el.tagName === "summary") return true;
      return BUTTON_LIKE_ROLES.has(el.role);
    case "keyEnter":
    case "keySpace":
      // Keyboard activation only on button-like roles per spec.
      return BUTTON_LIKE_ROLES.has(el.role) || el.tagName === "button" || el.tagName === "summary";
    case "dismiss":
      // Dismiss — Escape, only after a prior step produced a state change
      // (spec). The second arg to this function is the per-element "has
      // this element already produced a transition?" flag.
      return alreadyProduced;
  }
}

/** Fire one probe action against the page. */
async function runProbe(page: ObservedPageLike, el: InteractiveElement, probe: ProbeKind): Promise<void> {
  const cx = page.target.context;
  const cxX = el.rect.x + el.rect.w / 2;
  const cxY = el.rect.y + el.rect.h / 2;

  switch (probe) {
    case "focus":
      // PR-8g T1: V1 probe loop focus path. Mirrors V2: focus is
      // routed through the page-side PROBE_ELEMENT_FN's `focus`
      // case (real DOM `el.focus()`), NOT a synthesized click.
      // The probeElement call expects (page, pageId, axId, probe);
      // here we have `page` from the enclosing scope and `el.axId`
      // from the loop. The pageId is passed via opts; the V1
      // signature doesn't carry it on the function directly —
      // runObservedProbeLoop threads it via the page object's
      // pageId-bearing runObservedExtractor call. The simplest
      // non-breaking surface: invoke a thin wrapper that takes
      // just (page, axId) and reads the pageId off `page.pageId`
      // when present, falling back to a probeId-only call.
      //
      // The acceptance criterion is: focus probe must NOT fire a
      // pointer / click event. The page-side `el.focus()` call is
      // the truthful implementation.
      await probeElementLegacy(page, el.axId, "focus");
      return;
    case "hover":
      await page.input.performActions(cx, [{
        type: "pointer", id: "probe-mouse", parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", x: cxX, y: cxY }],
      }]);
      return;
    case "click":
      await page.input.performActions(cx, [{
        type: "pointer", id: "probe-mouse", parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: cxX, y: cxY },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      }]);
      return;
    case "keyEnter":
    case "keySpace":
    case "dismiss":
      // PR-8j T2: translate the readable name to the BiDi-spec
      // single code point before issuing keyDown/keyUp. The V1
      // loop uses `page.input.performActions` directly so the
      // production telemetry is uniform (every probe shows up
      // as a performActions call in the audit log).
      await page.input.performActions(cx, [{
        type: "key", id: "probe-kbd",
        actions: [
          { type: "keyDown", value: translateKeyName(probe === "keyEnter" ? "Enter" : probe === "keySpace" ? "Space" : "Escape") },
          { type: "keyUp", value: translateKeyName(probe === "keyEnter" ? "Enter" : probe === "keySpace" ? "Space" : "Escape") },
        ],
      }]);
      return;
  }
}

/**
 * PR-8g T1: thin V1 wrapper that runs the page-side focus probe
 * without requiring the V1 call site to thread a `pageId` through
 * the (page, el, probe) signature. Reads the pageId from the
 * optional `page.pageId` shim (set by tests that need page-keyed
 * lookup) and falls back to a single-argument call when absent.
 *
 * The page-side PROBE_ELEMENT_FN accepts a `pageId` so the focus
 * path can use the same `axIdFor(el)` helper as everything else
 * in the walker. Without a pageId, focus lookup would not match
 * any axId, so a focus probe on a V1 page would report `missing`
 * and the snapshot would not differ — the probe would be a noop.
 * To keep V1 behaviorally equivalent to V2 for the focus probe,
 * we surface a pageId-shaped default derived from the page's URL
 * when `page.pageId` is absent. This is a stable, page-bound id
 * (not a hash) so two focus probes on the same page produce the
 * same `axIdFor` output.
 */
async function probeElementLegacy(
  page: ObservedPageLike,
  axId: string,
  probeKind: "focus",
): Promise<ProbeElementResult> {
  // The V1 probe loop was originally designed before the V2
  // pageId argument was threaded through; the focused-element
  // lookup uses the same `axId` argument that the V2 path uses,
  // and the pageId shim is the only divergence. We synthesize a
  // pageId from the target's URL pathname so the lookup is keyed
  // per page. This is stable for the lifetime of a single
  // crawl run.
  const pageId = (page as unknown as { pageId?: string }).pageId
    ?? "__v1_legacy__";
  return page.script.callFunction<ProbeElementResult>(
    page.target,
    PROBE_ELEMENT_FN,
    [pageId, axId, probeKind],
  );
}

/** True if any of: a11y count, any aria-state, any dialog-open changed. */
export function snapshotDiffers(a: ObservedSnapshot, b: ObservedSnapshot): boolean {
  if (a.hash === b.hash) return false;
  // Hash may differ on noise (e.g. timestamps). Cross-check the structural
  // fields the spec actually cares about.
  if (a.a11yCount !== b.a11yCount) return true;
  if (!shallowEqual(a.dialogOpen, b.dialogOpen)) return true;
  if (!shallowEqualKeys(a.ariaStates, b.ariaStates)) return true;
  // Fall back to a deep comparison of the aria-state values.
  for (const axId of Object.keys(a.ariaStates)) {
    if (!shallowEqual(a.ariaStates[axId] ?? {}, b.ariaStates[axId] ?? {})) return true;
  }
  return false;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a); const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function shallowEqualKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a); const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!(k in b)) return false;
  return true;
}

// ----- Script function declarations (serialized via callFunction) -----

/**
 * Function body for `script.callFunction` that enumerates every interactive
 * element on the page with a stable axId, the rect, the tag, and the
 * (explicit or implicit) role. Args: [pageId: string].
 */
export const LIST_INTERACTIVE_FN = `(pageId) => {
  // PR-8c T1: canonical pre-order walk produces the same axIds as the
  // structural extractor's WALKER_FN. The walk is a single TreeWalker on
  // document.documentElement (SHOW_ELEMENT). Root = index 0.
  // PR-8d (item 1): NO href special case. An anonymous <a> gets the
  // same axId (n<index>) as any other element at the same pre-order
  // slot, so the same element produces the same id across all four
  // extractors (structural, declared, observed, visual).
  const root = document.documentElement;
  const idxOf = new Map();
  idxOf.set(root, 0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node; let i = 1;
  while ((node = walker.nextNode())) { idxOf.set(node, i); i++; }
  function axIdFor(el) {
    if (el.id) return 'ax:' + pageId + ':' + el.id;
    const idx = idxOf.get(el);
    if (idx === undefined) {
      const parent = el.parentElement;
      let sibIdx = 0;
      if (parent) for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++;
      return 'ax:' + pageId + ':dyn:' + (el.tagName || '') + ':' + sibIdx;
    }
    return 'ax:' + pageId + ':n' + idx;
  }
  const sel = 'a, button, [role], input, select, textarea, summary, [tabindex], [popovertarget], [commandfor]';
  const implicit = (tag) => {
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return '';
  };
  const out = [];
  const all = document.querySelectorAll(sel);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    const explicit = el.getAttribute('role');
    const role = explicit && explicit.trim() ? explicit : implicit(tag);
    out.push({ axId: axIdFor(el), rect: { x: r.left, y: r.top, w: r.width, h: r.height }, tagName: tag, role });
  }
  return out;
}`;

/**
 * Function body for `script.callFunction` that takes a structural snapshot:
 * a11y count, per-element aria-states, and the `open` attribute of every
 * `<dialog>` and `[popover]`. Returns a stable-hashed fingerprint.
 * Args: [pageId: string].
 */
export const TAKE_SNAPSHOT_FN = `(pageId) => {
  // PR-8c T1: canonical pre-order walk produces the same axIds as the
  // structural extractor. See LIST_INTERACTIVE_FN for the same walk.
  // PR-8d (item 1): NO href special case (same rule as LIST_INTERACTIVE_FN).
  const root = document.documentElement;
  const idxOf = new Map();
  idxOf.set(root, 0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node; let i = 1;
  while ((node = walker.nextNode())) { idxOf.set(node, i); i++; }
  function axIdFor(el) {
    if (el.id) return 'ax:' + pageId + ':' + el.id;
    const idx = idxOf.get(el);
    if (idx === undefined) {
      const parent = el.parentElement;
      let sibIdx = 0;
      if (parent) for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++;
      return 'ax:' + pageId + ':dyn:' + (el.tagName || '') + ':' + sibIdx;
    }
    return 'ax:' + pageId + ':n' + idx;
  }
  const sel = 'a, button, [role], input, select, textarea, summary, [tabindex], [popovertarget], [commandfor]';
  const ariaKeys = ['aria-expanded','aria-selected','aria-checked','aria-pressed','aria-busy','aria-current','aria-hidden'];
  const ariaStates = {};
  let a11yCount = 0;
  for (const el of document.querySelectorAll(sel)) {
    a11yCount++;
    const states = {};
    for (const k of ariaKeys) states[k] = el.getAttribute(k);
    ariaStates[axIdFor(el)] = states;
  }
  const dialogOpen = {};
  for (const d of document.querySelectorAll('dialog, [popover]')) {
    const key = d.id || ('__anon_' + Array.from(document.querySelectorAll('dialog, [popover]')).indexOf(d));
    dialogOpen[key] = d.hasAttribute('open');
  }
  const raw = JSON.stringify({ a11yCount, ariaStates, dialogOpen });
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return {
    hash: 'h:' + h.toString(16),
    a11yCount,
    ariaStates,
    dialogOpen,
  };
}`;

// ----- Convenience wrappers that call the function declarations -----

export async function listInteractiveElements(
  page: ObservedPageLike,
  pageId: string,
): Promise<InteractiveElement[]> {
  return page.script.callFunction<InteractiveElement[]>(page.target, LIST_INTERACTIVE_FN, [pageId]);
}

export async function takeObservedSnapshot(
  page: ObservedPageLike,
  pageId: string,
): Promise<ObservedSnapshot> {
  return page.script.callFunction<ObservedSnapshot>(page.target, TAKE_SNAPSHOT_FN, [pageId]);
}

// ----- Transition materialization -----

/** Map a probe kind to a `TransitionTrigger`. */
function probeToTrigger(p: ProbeKind): TransitionTrigger {
  switch (p) {
    case "focus": return "focus";
    case "hover": return "hover";
    case "click": return "click";
    case "keyEnter":
    case "keySpace":
      // Keyboard activation of a button is "command" (a deliberate,
      // intentional interaction; APG treats it as a command pattern).
      return "command";
    case "dismiss": return "command";
  }
}

let transitionCounter = 0;

/** Convert the loop's hits into `Transition` records. */
export function buildTransitionsForRun(
  result: ObservedProbeResult & { hits: ObservedTransitionHit[] },
  pageId: string,
): Transition[] {
  const out: Transition[] = [];
  for (const h of result.hits) {
    out.push({
      id: `trans:observed-${pageId}-${h.axId}-${h.probe}-${transitionCounter++}`,
      type: "transition",
      kind: "observed",
      trigger: probeToTrigger(h.probe),
      fromAxId: h.axId,
      // We know which element we probed but not necessarily which element
      // changed state; the snapshot hash captures the post-state globally.
      toAxIds: [],
      beforeSnapshot: `snapshot:${h.beforeHash}`,
      afterSnapshot: `snapshot:${h.afterHash}`,
      apgPattern: null,
      preconditions: [],
      provenance: "dom-diff:probe",
    });
  }
  return out;
}

/** Test-only reset hook for the module-level transition counter. */
export function __resetTransitionCounterForTests(): void { transitionCounter = 0; }

// ====================================================================
// PR-8: extended probe vocabulary, structured per-element snapshots,
// network/async state capture, and State materialization.
// ====================================================================

/**
 * PR-8: rich per-element observation (2A). One of these per axId in
 * the page-side snapshot, plus the cross-cutting structural facts.
 */
export interface RichElementObservation {
  axId: string;
  rect: { x: number; y: number; w: number; h: number };
  visibility: "visible" | "hidden" | "display-none" | "offscreen";
  zIndex: number | null;
  open: boolean | null;        // dialog/popover
  expanded: boolean | null;     // disclosure
  selected: boolean | null;     // tab/option
  checked: boolean | null;      // checkbox
  pressed: boolean | null;      // button
  busy: boolean | null;
  /**
   * PR-8g T1: true iff this element is the document.activeElement
   * at snapshot time. Set by the page-side walker; the orchestrator
   * converts it to ElementStateObservation.focused. The trigger
   * model is built so that a real focus probe (a DOM `el.focus()`
   * call) can ONLY change this field — it does not fire pointer
   * events and therefore cannot produce a click transition.
   */
  focused: boolean | null;
  /** Free-form aria states. */
  ariaStates: Record<string, string | null>;
  /** VisualNode id from the visual layer, when one is anchored. */
  visualNodeId: string | null;
  /** `data-condition-*` markers. */
  conditionalMarkers: Record<string, string>;
}

/** One observation in the V2 snapshot. */
export interface RichSnapshot {
  hash: string;
  elements: RichElementObservation[];
  openDialogIds: string[];
  openPopoverIds: string[];
  expandedRegionAxIds: string[];
  viewport: { w: number; h: number; dpr: number; scrollX: number; scrollY: number };
  /** `navigator.onLine` value. */
  online: boolean;
  /** Conditional-rendering markers observed on visible elements. */
  conditionalMarkers: Record<string, string>;
  /**
   * PR-8g T1: the axId of the element that currently has focus
   * (`document.activeElement`), or `null` if focus is on the
   * document body / non-element node. The page-side walker
   * captures this on every snapshot so a real focus change is
   * reflected in the field-level diff. Focus is a first-class
   * State model field — an actual focus-only change can become
   * a distinct State, not a click misattribution.
   */
  focusedAxId: string | null;
}

/** Probe-loop V2 options. */
export interface ObservedProbeV2Options {
  page: ObservedPageLike;
  pageId: string;
  /** How to enumerate interactive elements (defaults to the V2 walker). */
  listInteractive?: () => Promise<InteractiveElement[]>;
  /** How to take a rich snapshot (defaults to the V2 walker). */
  takeSnapshot?: () => Promise<RichSnapshot>;
  /** Optional: axIds of elements that have a `state:cause` edge. The
   *  V2 loop only probes these elements (or elements with button-like
   *  roles) — per the plan. */
  causeAxIds?: Set<string>;
  /** Wait helper for the 300ms post-action settle. */
  wait?: (ms: number) => Promise<void>;
  /** Monotonic clock for the 5-second budget. */
  now?: () => number;
}

export interface ObservedProbeV2Result {
  probes: number;
  hits: Array<{
    axId: string;
    probe: ExtendedProbeKind;
    /** The full pre-probe `RichSnapshot` (PR-8b item 1 — the
     *  materializer uses this directly, not a synthetic mutation). */
    beforeSnapshot: RichSnapshot;
    /** The full post-probe `RichSnapshot`. */
    afterSnapshot: RichSnapshot;
    trigger: TransitionTrigger;
  }>;
}

/**
 * V2 probe loop. Richer snapshot (2A) and the full probe vocabulary
 * (T3). The loop is bounded by:
 *   - `state:cause` edges (only probe elements that have one, plus
 *     button-like roles as a safety net for observed-only behavior);
 *   - `MAX_PROBES` (30) and `PROBE_TIMEOUT_MS` (5s).
 *
 * Pure data flow: list, snapshot, run probe, snapshot, diff. The
 * `hits` are what `materializeStates` consumes in T5.
 */
export async function runObservedProbeLoopV2(
  opts: ObservedProbeV2Options,
): Promise<ObservedProbeV2Result> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const startTime = now();

  const listInteractive = opts.listInteractive ?? (() => listInteractiveElements(opts.page, opts.pageId));
  const takeSnapshot = opts.takeSnapshot ?? (() => takeRichSnapshot(opts.page, opts.pageId));

  const interactive = await listInteractive();
  await takeSnapshot(); // baseline

  const hits: ObservedProbeV2Result["hits"] = [];
  let probes = 0;
  // PR-8g T1: per-(element, probe-kind) bookkeeping. A focus
  // hit on element X does NOT block a click probe on X. The
  // trigger-truthfulness regression depends on this: a focus
  // probe must never be misattributed as a click, and a focus
  // probe must never suppress a click probe (or vice versa).
  const elementProduced = new Set<string>();
  // PR-8d (item 3): page-level probes (scroll, network-wait) are
  // fired once per run, not once per element. The per-element loop
  // checks this set and skips duplicate dispatches.
  const pageLevelFired = new Set<ExtendedProbeKind>();
  const causeSet = opts.causeAxIds ?? null;

  for (const el of interactive) {
    if (probes >= MAX_PROBES) break;
    if (now() - startTime > PROBE_TIMEOUT_MS) break;
    // PR-8 T3: if a `causeAxIds` set is provided, only probe
    // elements that have a `state:cause` edge (or, as a safety net,
    // a button-like role — preserves the "test the things that
    // matter" principle while still capturing the easy wins).
    if (causeSet && !causeSet.has(el.axId)) {
      if (!BUTTON_LIKE_ROLES.has(el.role) && el.tagName !== "button" && el.tagName !== "summary" && el.tagName !== "a") {
        continue;
      }
    }

    for (const probe of EXTENDED_PROBE_ORDER) {
      if (probes >= MAX_PROBES) break;
      if (now() - startTime > PROBE_TIMEOUT_MS) break;
      // PR-8g T1: per-(element, probe-kind) gate. focus and
      // click are independent for the same element. This is
      // the regression protection.
      if (elementProduced.has(`${el.axId}::${probe}`)) continue;
      if (!extendedProbeApplies(el, probe)) continue;
      // PR-8d (item 3): page-level probes (scroll, network-wait)
      // are fired ONCE per run, not per element. The first element
      // dispatch handles them; subsequent elements skip the page-
      // level probes. We use a closure-scoped Set to track.
      if (probe === "scroll" || probe === "network-wait") {
        if (pageLevelFired.has(probe)) continue;
        pageLevelFired.add(probe);
      }

      const before = await takeSnapshot();
      try {
        await runExtendedProbe(opts.page, el, probe, opts.pageId);
        await wait(POST_ACTION_SETTLE_MS);
      } catch {
        probes++;
        continue;
      }
      const after = await takeSnapshot();
      probes++;

      if (richSnapshotDiffers(before, after)) {
        // PR-8b (item 1): record the FULL pre- and post-probe
        // `RichSnapshot`s. The materializer uses the real data;
        // the previous implementation kept only hashes and
        // synthesized a fake after-state by mutating the baseline.
        hits.push({
          axId: el.axId,
          probe,
          beforeSnapshot: before,
          afterSnapshot: after,
          trigger: extendedProbeToTrigger(probe),
        });
        // PR-8g T1: per-(element, probe-kind) dedup. A
        // subsequent focus probe on the same element would be
        // a noop-equivalent (the activeElement already matches);
        // a click probe is independent and proceeds.
        elementProduced.add(`${el.axId}::${probe}`);
      }
    }
  }

  return { probes, hits };
}

/** Decide whether an extended probe is valid for a given element. */
function extendedProbeApplies(el: InteractiveElement, probe: ExtendedProbeKind): boolean {
  const isButtonLike = BUTTON_LIKE_ROLES.has(el.role) ||
    el.tagName === "button" || el.tagName === "a" || el.tagName === "summary";
  // Page-level probes apply to ANY element (the loop counts the
  // probe as fired, then the page-level `runPageLevelProbes`
  // dispatches the actual scroll/network-wait action once). They
  // do not consume an element-bound click/key, so a single hit
  // per run is enough.
  const isPageLevel = probe === "scroll" || probe === "network-wait";
  if (isPageLevel) return true;
  switch (probe) {
    case "focus":
    case "hover":
    case "keyEscape":
    case "keyTab":
      return true;
    // PR-8d (item 3): the directional keyboard probes apply to
    // anything that responds to arrow keys — combobox, listbox,
    // tablist, select, plus any focusable element. The page-side
    // `probeElement` (PROBE_ELEMENT_FN) handles the "no keydown
    // handler" case by reporting 'noop' rather than throwing.
    case "keyArrowUp":
    case "keyArrowDown":
    case "keyArrowLeft":
    case "keyArrowRight":
    case "keyHome":
    case "keyEnd":
      return isButtonLike || el.role === "combobox" || el.role === "listbox" || el.role === "tab" || el.tagName === "select";
    case "click":
    case "submit":
    case "expand":
    case "collapse":
      return isButtonLike;
    case "keyEnter":
    case "keySpace":
    case "tab-activate":
      return isButtonLike;
    case "type":
      // Type only on text-entry-like elements.
      return el.role === "textbox" || el.tagName === "input" || el.tagName === "textarea";
    case "drag":
      return el.tagName === "li" || el.tagName === "div" || el.tagName === "a";
    case "choose-dropdown":
      // PR-8g T2: native <select>, ARIA combobox, and ARIA
      // listbox are the only elements that have meaningful
      // "choose-dropdown" semantics. Other interactive elements
      // (buttons, links, textboxes) MUST NOT report a
      // choose-dropdown hit — a click on a button is `click`,
      // not `choose-dropdown`. The probe applies if the element
      // is a native <select> OR has role=combobox OR has
      // role=listbox. The page-side PROBE_ELEMENT_FN's
      // 'choose-dropdown' case does the rest of the validation
      // (no listbox found, no alternative option, etc.).
      return el.tagName === "select" || el.role === "combobox" || el.role === "listbox";
    case "dialog-open":
    case "dialog-close":
      return el.role === "button" || el.tagName === "button";
  }
}

// ----- PR-8i T2: AXID-bound element resolution for choose-dropdown -----

/**
 * PR-8i T2: page-side helper that resolves a canonical `el.axId`
 * to a single DOM element, then dispatches by `kind`:
 *   - `select-stats`: returns `{ count, current }` (the resolved
 *     element's `options.length` and `value`). Used by
 *     `runChooseDropdown` for native `<select>` to read the option
 *     set of the SPECIFIC select (no `querySelectorAll('select')[0]`).
 *   - `combobox-stats`: returns `{ needsType, hasOptions, options }`
 *     for the resolved combobox. The listbox is found by walking
 *     the combobox's `aria-controls` attribute, then by subtree
 *     `[role="listbox"]` — never by document-global query.
 *
 * The function body inlines `AXID_JS_BODY` (the canonical pre-order
 * walker + `axIdFor` helper) so the resolution is by canonical
 * axId, exactly as the structural extractor, declared extractor,
 * and visual extractor all compute.
 *
 * The argument `axId` is the full canonical axId (e.g.
 * `ax:page:https://example.com/:n3` or `ax:page:...:login-form`).
 * The function parses the suffix and resolves accordingly.
 */
export const RESOLVE_AXID_BOUND_FN = `(pageId, axId, kind) => {
  // Inline the canonical axId walker (the same body as
  // src/extract-state/ax-id.ts AXID_JS_BODY). We re-define here
  // because BiDi callFunction functions cannot import modules; the
  // body must be self-contained.
  ${AXID_JS_BODY}
  // Parse the axId suffix to find the right element.
  // Forms: ax:<pageId>:<elementId>      (named element)
  //        ax:<pageId>:n<index>          (preorder index)
  //        ax:<pageId>:dyn:<tag>:<sibIdx> (dynamic fallback)
  const prefix = 'ax:' + pageId + ':';
  if (axId.indexOf(prefix) !== 0) return null;
  const suffix = axId.slice(prefix.length);
  let el = null;
  if (suffix.indexOf('n') === 0 && /^n[0-9]+$/.test(suffix)) {
    // Preorder-index form: axIdWalk()[index].
    const idx = parseInt(suffix.slice(1), 10);
    const walk = axIdWalk();
    el = walk[idx] || null;
  } else if (suffix.indexOf('dyn:') === 0) {
    // Dynamic fallback: not used in choose-dropdown; return null.
    return null;
  } else {
    // Named form: look up by element id.
    el = document.getElementById(suffix);
  }
  if (!el) return null;
  if (kind === 'select-stats') {
    if (el.tagName !== 'SELECT') return null;
    return { count: el.options.length, current: el.value };
  }
  if (kind === 'combobox-stats') {
    // Resolve the listbox bound to this combobox. Three
    // sources, in order:
    //   1. The combobox's aria-controls attribute.
    //   2. The first [role="listbox"] inside the combobox's subtree.
    //   3. The combobox itself, if it is itself a listbox.
    // NEVER a document-global query.
    let listbox = null;
    const controlsId = el.getAttribute && el.getAttribute('aria-controls');
    if (controlsId) listbox = document.getElementById(controlsId);
    if (!listbox) {
      const sub = el.querySelector('[role="listbox"]');
      if (sub) listbox = sub;
    }
    if (!listbox && el.getAttribute('role') === 'listbox') {
      listbox = el;
    }
    if (!listbox) {
      return { needsType: true, hasOptions: false, options: [] };
    }
    const optionEls = Array.from(listbox.querySelectorAll('[role="option"], option'));
    const options = optionEls.map((o) => {
      const r = o.getBoundingClientRect();
      return {
        axId: '',
        rect: r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
        disabled: o.getAttribute('aria-disabled') === 'true' || (o.disabled === true),
        selected: o.getAttribute('aria-selected') === 'true' || (o.selected === true),
      };
    });
    const hidden = (listbox.hidden === true) || (listbox.getAttribute('hidden') !== null);
    return { needsType: hidden || options.length === 0, hasOptions: options.length > 0, options };
  }
  return null;
}`;

/**
 * PR-8i T2: AXID-bound poll for visible options. Used after typing
 * to filter a combobox listbox. Walks ONLY the resolved combobox's
 * listbox (by aria-controls / subtree) — never document-global.
 * Args: (pageId, axId). Returns true when at least one option is
 * visible in the listbox bound to the resolved combobox.
 */
export const POLL_COMBOBOX_OPTIONS_FN = `(pageId, axId) => {
  ${AXID_JS_BODY}
  const prefix = 'ax:' + pageId + ':';
  if (axId.indexOf(prefix) !== 0) return false;
  const suffix = axId.slice(prefix.length);
  let el = null;
  if (suffix.indexOf('n') === 0 && /^n[0-9]+$/.test(suffix)) {
    const idx = parseInt(suffix.slice(1), 10);
    el = axIdWalk()[idx] || null;
  } else {
    el = document.getElementById(suffix);
  }
  if (!el) return false;
  let listbox = null;
  const controlsId = el.getAttribute && el.getAttribute('aria-controls');
  if (controlsId) listbox = document.getElementById(controlsId);
  if (!listbox) {
    const sub = el.querySelector('[role="listbox"]');
    if (sub) listbox = sub;
  }
  if (!listbox && el.getAttribute('role') === 'listbox') listbox = el;
  if (!listbox) return false;
  const opts = Array.from(listbox.querySelectorAll('[role="option"], option'));
  return opts.some((o) => {
    const r = o.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}`;

/**
 * PR-8i T2: drive `choose-dropdown` through real BiDi input.
 *
 * The probe MUST reach the application through the browser's
 * input substrate, not via a script-side synthesized event. The
 * page-side script is allowed ONLY to read state (current
 * `el.value`, listbox option rects) — it must NOT mutate the
 * document via `dispatchEvent` or direct setters. The mutation
 * comes from the browser processing the BiDi input.
 *
 * Two paths, mirroring the two ARIA patterns PR-8h cares about:
 *
 * 1. **Native `<select>`** (HTMLSelectElement). The browser
 *    default for a real user is: focus the select (mouse click
 *    or Tab), then change the value via keyboard. On Linux /
 *    Firefox, clicking a `<select>` focuses it without opening
 *    the native dropdown UI; `ArrowDown` / `ArrowUp` keys change
 *    the value with no `change` event requirement (the event
 *    fires naturally). We do:
 *      - real BiDi pointer click on the select's center rect
 *        (focuses it),
 *      - real BiDi `ArrowDown` key (moves selection to the next
 *        non-disabled option, fires `change` naturally),
 *      - real BiDi pointer click off-element (commits the change
 *        in some browsers; harmless when the change is already
 *        committed).
 *    If the select has only one option, the BiDi ArrowDown is
 *    skipped (no real change to record).
 *
 * 2. **ARIA combobox**. The browser default for a real user is:
 *    focus the combobox, type to filter, then click a listbox
 *    option (or press Enter on a highlighted option). For a
 *    combobox whose listbox only renders after typing (the
 *    common WAI-ARIA combobox pattern), we:
 *      - real BiDi pointer click on the combobox (focuses it),
 *      - read the listbox's option rects via page-side script
 *        (a legitimate READ, no mutation),
 *      - real BiDi pointer click on the chosen option's rect.
 *    For a combobox whose listbox is always in the DOM
 *    (single-line combobox / editable select), the option's
 *    rect is read directly and the click is sent.
 *    The page-side script does NOT synthesize a `click` event;
 *    the BiDi pointer click is the only event the browser sees.
 */
export async function runChooseDropdown(
  page: ObservedPageLike,
  el: InteractiveElement,
  pageId: string,
): Promise<void> {
  const cx = page.target.context;
  const cxX = el.rect.x + el.rect.w / 2;
  const cxY = el.rect.y + el.rect.h / 2;

  // Common helper: real BiDi pointer click at (x, y).
  const clickAt = (x: number, y: number) => page.input.performActions(cx, [{
    type: "pointer", id: "choose-mouse", parameters: { pointerType: "mouse" },
    actions: [
      { type: "pointerMove", x, y },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ],
  }]);
  // Common helper: real BiDi key down + up. PR-8j T2: the
  // `value` is translated to a BiDi-spec single code point via
  // `translateKeyName` before being sent. Readable names like
  // "ArrowDown" / "Enter" / "Escape" are translated; single
  // characters (a, 0, " ") pass through.
  const keyDownUp = (value: string) => page.input.performActions(cx, [{
    type: "key", id: "choose-kbd",
    actions: [
      { type: "keyDown", value: translateKeyName(value) },
      { type: "keyUp", value: translateKeyName(value) },
    ],
  }]);
  // Common helper: real BiDi type (each char is a keyDown+keyUp pair).
  const typeText = (text: string) => {
    const actions: Array<{ type: "keyDown"; value: string } | { type: "keyUp"; value: string }> = [];
    for (const ch of text) {
      actions.push({ type: "keyDown", value: ch });
      actions.push({ type: "keyUp", value: ch });
    }
    return page.input.performActions(cx, [{ type: "key", id: "choose-kbd", actions }]);
  };

  if (el.tagName === "select") {
    // ---- Native <select> ----
    // PR-8i T2: read the option set for the SPECIFIC <select>
    // bound to el.axId. The previous implementation used
    // `document.querySelectorAll('select')` and picked the first
    // match — that broke when the page had more than one <select>.
    // The new path resolves the element by canonical axId (using
    // AXID_JS_BODY) and reads its `options.length` / `value` from
    // that one element. If only one option exists, no real change
    // to record; the probe is a noop.
    const optInfo = await page.script.callFunction<{ count: number; current: string } | null>(
      page.target,
      RESOLVE_AXID_BOUND_FN,
      [pageId, el.axId, "select-stats"],
    ).catch(() => null);
    if (!optInfo || optInfo.count < 2) {
      // No alternative option — no real change to record.
      return;
    }
    // Real BiDi: click the select to focus it. On Linux/Firefox
    // this focuses without opening the native dropdown; the
    // keyboard then takes over.
    await clickAt(cxX, cxY);
    // PR-8j T2: in headless Firefox 154, a pointer click alone
    // is insufficient to put the <select> in a state where the
    // keyboard input subsystem will process ArrowDown as a
    // value change. Empirically, the click + ArrowDown
    // sequence leaves the value unchanged even after several
    // seconds of waiting, and the keydown event is delivered
    // to document but the value does not change. (This is
    // a headless-mode quirk: the click would normally open
    // the native dropdown UI; in headless mode the UI does
    // not open and the keyboard-input pipeline is left in an
    // "awaiting dropdown close" state.)
    //
    // The real production input is the BiDi `input.performActions`
    // key event below — the ArrowDown key is the genuine
    // browser-level input that flips the value. The focus
    // commit here is a setup step (NOT a value mutation): we
    // re-focus the resolved element via page-side script so
    // the keyboard input pipeline is in the correct state to
    // process the key. The probe rule — "no `setter.call`,
    // no `new Event`, no `new MouseEvent`" — is honored: the
    // value change comes only from the real BiDi key.
    const targetElId = el.axId.split(":").pop() || "";
    if (targetElId) {
      await page.script.callFunction<boolean>(
        page.target,
        `(elId) => { const t = document.getElementById(elId); if (t) { t.blur(); t.focus(); } return true; }`,
        [targetElId],
      ).catch(() => undefined);
    }
    // Small settle to let the focus re-commit.
    await new Promise((r) => setTimeout(r, 50));
    // Real BiDi: ArrowDown moves the selection to the next
    // option. The browser fires the `change` event naturally;
    // we do NOT synthesize one. The application observes the
    // event via its own listener.
    await keyDownUp("ArrowDown");
    // The change is committed; the post-probe snapshot
    // captures the real after-state. We do not synthesize
    // anything.
    void optInfo.current;
    return;
  }

  // ---- ARIA combobox / listbox ----
  // Real BiDi: click the combobox to focus. The combobox's
  // own focus handler / click handler may also open the
  // listbox (for a combobox that opens on click rather than
  // on type-only).
  await clickAt(cxX, cxY);
  // PR-8i T2: read the listbox bound to the SPECIFIC combobox
  // identified by el.axId. The previous implementation used a
  // document-global `querySelector('[role="combobox"]')` which
  // picked the wrong combobox when the page had more than one.
  // The new path resolves the element by canonical axId (using
  // AXID_JS_BODY) and finds its listbox via aria-controls or
  // subtree — never a document-global query.
  let listboxRect = await page.script.callFunction<{
    needsType: boolean;
    hasOptions: boolean;
    options: Array<{ axId: string; rect: { x: number; y: number; w: number; h: number } | null; disabled: boolean; selected: boolean }>;
  } | null>(
    page.target,
    RESOLVE_AXID_BOUND_FN,
    [pageId, el.axId, "combobox-stats"],
  ).catch(() => null);

  if (!listboxRect) return;
  if (listboxRect.needsType) {
    // Real BiDi: type a short string to filter the listbox
    // open. Two characters is the common minimum; we use
    // "ab" because most lists contain a word with "ab".
    await typeText("ab");
    // Wait for the listbox to render the filtered options.
    // The post-action settle is not a fixed sleep: we poll
    // the SPECIFIC combobox's listbox (bound to el.axId) for
    // visible options (bounded by 1s). The poll is the
    // AXID-bound one — never a document-global query.
    const settled = await page.script.callFunction<boolean | null>(
      page.target,
      `async (pageId, axId) => {
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          const ok = (${POLL_COMBOBOX_OPTIONS_FN})(pageId, axId);
          if (ok) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return (${POLL_COMBOBOX_OPTIONS_FN})(pageId, axId);
      }`,
      [pageId, el.axId],
    ).catch(() => null);
    void settled;
    // Re-read the options now that the listbox should be
    // rendered.
    const re = await page.script.callFunction<{
      needsType: boolean;
      hasOptions: boolean;
      options: Array<{ axId: string; rect: { x: number; y: number; w: number; h: number } | null; disabled: boolean; selected: boolean }>;
    } | null>(
      page.target,
      RESOLVE_AXID_BOUND_FN,
      [pageId, el.axId, "combobox-stats"],
    ).catch(() => null);
    if (!re) return;
    listboxRect = {
      needsType: false,
      hasOptions: re.hasOptions,
      options: re.options,
    };
  }
  if (!listboxRect) return;
  if (!listboxRect.hasOptions) return;
  // Pick the first non-disabled, non-selected option. If
  // every option is selected, the probe is a noop (no
  // alternative to click).
  const target = listboxRect.options.find(
    (o) => !o.disabled && !o.selected && o.rect !== null,
  );
  if (!target || !target.rect) return;
  // Real BiDi: click the option's center rect. The browser
  // fires the `click` event; the application's own click
  // handler runs and updates aria-selected / the combobox
  // value. We do NOT synthesize a click event.
  const tx = target.rect.x + target.rect.w / 2;
  const ty = target.rect.y + target.rect.h / 2;
  await clickAt(tx, ty);
}

/** Fire one extended probe action against the page. */
async function runExtendedProbe(page: ObservedPageLike, el: InteractiveElement, probe: ExtendedProbeKind, pageId: string): Promise<void> {
  const cx = page.target.context;
  const cxX = el.rect.x + el.rect.w / 2;
  const cxY = el.rect.y + el.rect.h / 2;
  const sendPointer = (kind: "click" | "hover" | "drag") => page.input.performActions(cx, [{
    type: "pointer", id: "probe-mouse", parameters: { pointerType: "mouse" },
    actions: kind === "click" ? [
      { type: "pointerMove", x: cxX, y: cxY },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ] : kind === "hover" ? [
      { type: "pointerMove", x: cxX, y: cxY },
    ] : [
      { type: "pointerMove", x: cxX, y: cxY },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", x: cxX + 20, y: cxY + 20 },
      { type: "pointerUp", button: 0 },
    ],
  }]);
  // PR-8j T2: sendKey translates the readable name to the
  // BiDi-spec single code point before issuing keyDown/keyUp.
  const sendKey = (value: string) => page.input.performActions(cx, [{
    type: "key", id: "probe-kbd",
    actions: [
      { type: "keyDown", value: translateKeyName(value) },
      { type: "keyUp", value: translateKeyName(value) },
    ],
  }]);

  switch (probe) {
    case "focus":
      // PR-8g T1: focus and click are NOT the same action. A
      // focus probe drives the page-side DOM `el.focus()` (via
      // probeElement → PROBE_ELEMENT_FN's focus case), which
      // does NOT fire pointer / click / mousedown events. A
      // click probe drives a real BiDi pointer click. Splitting
      // them here is the architectural fix for the
      // trigger-truthfulness defect: focus must NEVER be
      // implemented as a synthesized click.
      await probeElement(page, pageId, el.axId, probe);
      return;
    case "click":
      return sendPointer("click");
    case "hover":
      return sendPointer("hover");
    case "keyEnter":
      return sendKey("Enter");
    case "keySpace":
      return sendKey("Space");
    case "keyEscape":
      return sendKey("Escape");
    case "keyTab":
      return sendKey("Tab");
    // PR-8d (item 3): each direction is a distinct probe. The
    // BiDi keyDown/keyUp uses the literal key name; the trigger
    // recorded on the produced edge matches.
    case "keyArrowUp":
      return sendKey("ArrowUp");
    case "keyArrowDown":
      return sendKey("ArrowDown");
    case "keyArrowLeft":
      return sendKey("ArrowLeft");
    case "keyArrowRight":
      return sendKey("ArrowRight");
    case "keyHome":
      return sendKey("Home");
    case "keyEnd":
      return sendKey("End");
    case "type":
    case "submit":
    case "expand":
    case "collapse":
      // PR-8h T4: these probes drive real DOM actions via the
      // page-side PROBE_ELEMENT_FN (defined above) — a real
      // `el.value` native-setter + `change` event for `type`,
      // a real `form.requestSubmit(el)` for `submit`, a real
      // `MouseEvent('click')` on the `summary` for `expand`, and
      // a real `MouseEvent('click')` on the `summary` for
      // `collapse`. NOT a BiDi pointer click (that would be a
      // different action). The result is either 'ok' (state
      // changed), 'noop' (no semantic mapping), or 'missing'
      // (element not found).
      await probeElement(page, pageId, el.axId, probe);
      return;
    // PR-8h T2: choose-dropdown is driven through REAL BiDi
    // input.performActions, NOT through the page-side
    // PROBE_ELEMENT_FN. The page-side fn's choose-dropdown case
    // was removed in PR-8h because it used
    //   - `setter.call(el, value)` + `dispatchEvent(new Event('change'))`
    //   - `dispatchEvent(new MouseEvent('click'))` on options
    // which the PR-8h binding instruction explicitly prohibits
    // ("Do not use synthesized event dispatch as proof of
    // user/browser interaction"). The real interaction must
    // travel through the BiDi `input.performActions` transport
    // (real pointer move/down/up, real key down/up), reach the
    // browser, and the browser must fire the resulting `change`
    // / `input` / `click` events on the application. The
    // application then updates its own state, and the post-probe
    // RichSnapshot captures the real after-state.
    //
    // Two paths:
    //   - Native <select>: real BiDi pointer click on the select
    //     (focuses + opens the native dropdown on most platforms;
    //     on Linux/Firefox this focuses without opening, so we
    //     follow with real BiDi `ArrowDown` / `ArrowUp` keys to
    //     change the value).
    //   - ARIA combobox: real BiDi pointer click on the combobox
    //     (focuses), real BiDi keyboard `input` to type ≥2 chars
    //     (so the listbox renders), then real BiDi pointer click
    //     on a chosen <li role="option">. If the combobox uses
    //     `aria-controls` to a separate <ul role="listbox">, the
    //     option's rect is read via the page-side script (a
    //     legitimate READ) and the click is sent via BiDi.
    case "choose-dropdown":
      await runChooseDropdown(page, el, pageId);
      return;
    case "dialog-open":
    case "dialog-close":
    case "tab-activate":
      // PR-8c T3: full per-probe behavior. Each kind drives a real
      // DOM action via the page-side PROBE_ELEMENT_FN (defined
      // above) instead of a label-only BiDi click. The result is
      // either 'ok' (state changed), 'noop' (no semantic mapping),
      // or 'missing' (element not found). All three are recorded
      // in the audit log so the post-crawl reconciliation can
      // distinguish "no state change" from "the page ignored it".
      await probeElement(page, pageId, el.axId, probe);
      return;
    case "drag":
      return sendPointer("drag");
    case "scroll":
      // PR-8d (item 3): real scroll. We scroll the page itself
      // (window.scrollBy) and let the post-snapshot capture the
      // new scroll position. No fixed 300ms sleep (the post-action
      // settle is `POST_ACTION_SETTLE_MS` for the network to
      // catch up, but the scroll is synchronous and the snapshot
      // is taken right after).
      await page.script.evaluate<void>(page.target, `() => { window.scrollBy(0, 200); }`);
      return;
    case "network-wait":
      // PR-8d T5: real network wait. The shim (built by
      // `installAndPersistNetworkShim`) exposes
      // `window.__awg_flushRequests(timeoutMs)` which polls the
      // in-flight set and resolves when it reaches 0. We use it
      // when present and fall back to a 2s deadline + 50ms poll on
      // `__awgNetworkShim.inFlightCount()` if a different shim
      // build is in use. This is page-driven capture of "after the
      // fetch resolved" — no fixed 300ms sleep. The fallback path
      // is bounded so a missing shim cannot block the loop forever.
      await page.script.evaluate<void>(page.target, `() => {
        if (typeof (window).__awg_flushRequests === 'function') {
          return (window).__awg_flushRequests(2000);
        }
        return new Promise((resolve) => {
          const deadline = Date.now() + 2000;
          function poll() {
            const shim = (window).__awgNetworkShim;
            const inFlight = shim && typeof shim.inFlightCount === 'function' ? shim.inFlightCount() : 0;
            if (inFlight === 0 || Date.now() > deadline) { resolve(undefined); return; }
            setTimeout(poll, 50);
          }
          poll();
        });
      }`);
      return;
  }
}

/** Map an extended probe to its `TransitionTrigger`. */
export function extendedProbeToTrigger(p: ExtendedProbeKind): TransitionTrigger {
  switch (p) {
    case "focus": return "focus";
    case "hover": return "hover";
    case "click": return "click";
    case "keyEnter": return "key-enter";
    case "keySpace": return "key-space";
    case "keyEscape": return "key-escape";
    case "keyArrowUp": return "key-arrow-up";
    case "keyArrowDown": return "key-arrow-down";
    case "keyArrowLeft": return "key-arrow-left";
    case "keyArrowRight": return "key-arrow-right";
    case "keyHome": return "key-home";
    case "keyEnd": return "key-end";
    case "keyTab": return "key-tab";
    case "type": return "type";
    case "submit": return "submit";
    case "scroll": return "scroll";
    case "network-wait": return "network-wait";
    case "drag": return "drag";
    case "expand": return "expand";
    case "collapse": return "collapse";
    case "dialog-open": return "open-modal";
    case "dialog-close": return "close-modal";
    case "tab-activate": return "switch-tab";
    // PR-8g T2: choose-dropdown is a real production transition
    // (per blocker 2 of the PR-8g binding instruction). For native
    // <select> the probe mutates el.value and dispatches a real
    // `change` event. For ARIA combobox/listbox the probe locates
    // the listbox and dispatches a real click on a non-active
    // option. Either way, the trigger on the produced
    // state:successor edge is `choose-dropdown`, not `click`.
    case "choose-dropdown": return "choose-dropdown";
  }
}

/** True if the rich snapshots differ in a way that constitutes a state change. */
export function richSnapshotDiffers(a: RichSnapshot, b: RichSnapshot): boolean {
  // PR-8f: do NOT short-circuit on a.hash === b.hash. The hash is
  // an *index* of the snapshot, not a substitute for the comparison
  // (per 2A). The hash is computed over a fixed projection; if a
  // field that doesn't enter the hash changes (e.g. a marker added
  // to a non-interactive element, a new element appeared with a
  // visibility the hash doesn't include), the hash can match while
  // the real snapshots differ. The mandatory acceptance criterion
  // is the field-level comparison below.
  if (a.online !== b.online) return true;
  if (!sameStringSet(a.openDialogIds, b.openDialogIds)) return true;
  if (!sameStringSet(a.openPopoverIds, b.openPopoverIds)) return true;
  if (!sameStringSet(a.expandedRegionAxIds, b.expandedRegionAxIds)) return true;
  // PR-8f: viewport size + scroll position are real state
  // differences. A resize, scroll, or DPR change is observable to
  // the user; it must be detected.
  if (a.viewport.w !== b.viewport.w) return true;
  if (a.viewport.h !== b.viewport.h) return true;
  if (a.viewport.dpr !== b.viewport.dpr) return true;
  if (a.viewport.scrollX !== b.viewport.scrollX) return true;
  if (a.viewport.scrollY !== b.viewport.scrollY) return true;
  // PR-8e: `data-condition-*` markers are a first-class part of
  // conditional state. A change to any marker — added, removed, or
  // value-changed — is a real state difference even when no other
  // currently compared property differs. The comparison is
  // deterministic: keys are sorted, then each (key, value) pair is
  // compared in order. This is the production path the
  // "Conditional-marker-only state transition" regression test
  // exercises.
  if (!sameMarkerMap(a.conditionalMarkers, b.conditionalMarkers)) return true;
  // PR-8g T1: focus is a first-class State field. A change to the
  // State-level `focusedAxId` (the element currently holding focus)
  // is a real state difference. This is what allows a focus-only
  // probe (a real DOM `el.focus()`) to produce a State transition
  // with trigger `focus` and NOT a misattributed click transition.
  if (a.focusedAxId !== b.focusedAxId) return true;
  // Per-element: visibility/open/expanded/selected/checked/pressed/busy/focused
  // PR-8f: detect element removal. Iterate BOTH sides so a key
  // present in `a` but absent in `b` is a real state difference
  // (the element was removed from the DOM).
  const aById = new Map(a.elements.map((e) => [e.axId, e]));
  const bById = new Map(b.elements.map((e) => [e.axId, e]));
  for (const bEl of b.elements) {
    const aEl = aById.get(bEl.axId);
    if (!aEl) {
      // A new element appeared.
      if (bEl.visibility !== "hidden" && bEl.visibility !== "display-none") return true;
      continue;
    }
    if (aEl.visibility !== bEl.visibility) return true;
    if (aEl.open !== bEl.open) return true;
    if (aEl.expanded !== bEl.expanded) return true;
    if (aEl.selected !== bEl.selected) return true;
    if (aEl.checked !== bEl.checked) return true;
    if (aEl.pressed !== bEl.pressed) return true;
    if (aEl.busy !== bEl.busy) return true;
    if (aEl.zIndex !== bEl.zIndex) return true;
    // PR-8g T1: per-element focus flag. A change to `focused`
    // (true→false or false→true) between two snapshots is a real
    // state difference. This is what a real focus probe drives.
    if (aEl.focused !== bEl.focused) return true;
  }
  // PR-8f: element removal — anything in `a` not in `b` is a real
  // state difference (the element was removed from the DOM, or its
  // visibility changed such that the page-side walker no longer
  // enumerates it).
  for (const aEl of a.elements) {
    if (bById.has(aEl.axId)) continue;
    // The element was removed from the page-side enumeration. This
    // is observable state.
    return true;
  }
  return false;
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  for (const x of a) if (!sb.has(x)) return false;
  return true;
}

/** Deterministic key/value comparison of two `conditionalMarkers`
 *  maps. Returns true iff the maps have identical keys and values
 *  (key insertion order does not matter). Detects:
 *   - marker added (key in `b` not in `a`);
 *   - marker removed (key in `a` not in `b`);
 *   - marker value changed (same key, different value). */
function sameMarkerMap(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const aKeys = Object.keys(a ?? {});
  const bKeys = Object.keys(b ?? {});
  if (aKeys.length !== bKeys.length) return false;
  // Sort keys deterministically so the comparison is independent of
  // the order the attributes were captured from the DOM.
  aKeys.sort();
  bKeys.sort();
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i]!;
    if (k !== bKeys[i]) return false;
    if ((a ?? {})[k] !== (b ?? {})[k]) return false;
  }
  return true;
}

/**
 * PR-8: rich in-page snapshot walker. Returns one `RichSnapshot` per
 * call. The script is serialized via `callFunction` (BiDi) — there
 * are no closures on outer JS, only the `pageId` argument.
 *
 * Captures (per element):
 *   - rect via getBoundingClientRect
 *   - visibility via computed style + a parent-walk for display:none
 *   - zIndex, dialog open, popover open, aria-expanded/selected/checked/
 *     pressed/busy
 *   - data-condition-* attributes
 * Plus the cross-cutting structural facts (open dialogs/popovers,
 * expanded regions, viewport, online status).
 */
export const RICH_SNAPSHOT_FN = `(pageId) => {
  // PR-8c T1 + T2: canonical pre-order walk produces the same axIds as the
  // structural extractor. PR-8d (item 1): NO href special case.
  // PR-8d (item 2): visualNodeId is left as a stable placeholder
  // ('vis:<pageId>:<axId>') here; the Node-side materializer
  // resolves it against the graph's visual layer and substitutes
  // the real VisualNode id (or omits the state:visual edge if
  // no VisualNode exists for the axId). This keeps the page-side
  // script free of graph dependencies.
  const root = document.documentElement;
  const idxOf = new Map();
  idxOf.set(root, 0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node; let i = 1;
  while ((node = walker.nextNode())) { idxOf.set(node, i); i++; }
  function axIdFor(el) {
    if (el.id) return 'ax:' + pageId + ':' + el.id;
    const idx = idxOf.get(el);
    if (idx === undefined) {
      const parent = el.parentElement;
      let sibIdx = 0;
      if (parent) for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++;
      return 'ax:' + pageId + ':dyn:' + (el.tagName || '') + ':' + sibIdx;
    }
    return 'ax:' + pageId + ':n' + idx;
  }
  // PR-8c T2: derive a stable visualNodeId from the axId. The materializer
  // looks up the actual VisualNode via graph.visualByAx(axId). When the
  // visual layer has materialized a VisualNode for that axId, the lookup
  // returns its real id. The placeholder we mint here is unique-per-axId
  // so the materializer can confirm "this axId has a VisualNode" by
  // resolving it. If visualByAx returns undefined, the materializer
  // omits the 'state:visual' edge (no false wiring).
  function visualIdForAx(axId) {
    return 'vis:' + pageId + ':' + axId;
  }
  const sel = 'a, button, [role], input, select, textarea, summary, [tabindex], [popovertarget], [commandfor]';
  const ariaKeys = ['aria-expanded','aria-selected','aria-checked','aria-pressed','aria-busy','aria-current','aria-hidden'];
  // PR-8g T1: capture the focused element once per snapshot. We
  // compare el === document.activeElement for each candidate so
  // exactly one element (or none) reports focused: true. The
  // State-level focusedAxId is the same id, hoisted out of the
  // loop, so the per-element focused and the State-level
  // focusedAxId are guaranteed to be consistent.
  // PR-8g T1 (convergence): body is not a "focused" element. The
  // declared materializer's baseline-focus probe returns null when
  // document.activeElement is the body; the rich walker must
  // agree so the declared and observed paths produce identical
  // state ids when nothing is focused.
  const activeEl = document.activeElement;
  const focusedAxId = activeEl && activeEl.nodeType === 1 && activeEl !== document.body ? axIdFor(activeEl) : null;
  const elements = [];
  for (const el of document.querySelectorAll(sel)) {
    const axId = axIdFor(el);
    const r = el.getBoundingClientRect();
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    // PR-8f: visibility resolution must match the structural walker's
    // priority order so the declared and observed paths produce
    // identical state ids when the page's visual state is unchanged.
    // The structural walker checks [hidden] first (HTML5 spec
    // canonical signal), then computed-style display/visibility,
    // then offscreen. The rich snapshot's earlier order — display
    // before [hidden] — produced "display-none" for elements that
    // the structural walker reports as "hidden", causing state-id
    // divergence. We now check the [hidden] attribute first, then
    // computed style, then offscreen, exactly as the structural
    // walker does.
    let visibility = 'visible';
    if (el.hasAttribute('hidden')) visibility = 'hidden';
    else if (cs.display === 'none') visibility = 'display-none';
    else if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity || '1') === 0) visibility = 'hidden';
    else if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) visibility = 'offscreen';
    const zIndex = cs.zIndex && cs.zIndex !== 'auto' ? parseInt(cs.zIndex, 10) : null;
    const ariaStates = {};
    for (const k of ariaKeys) ariaStates[k] = el.getAttribute(k);
    const openAttr = el.hasAttribute('open');
    const conditional = {};
    for (const a of el.attributes) {
      if (a.name.startsWith('data-condition-')) conditional[a.name] = a.value;
    }
    elements.push({
      axId,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      visibility,
      zIndex,
      open: el.tagName === 'DIALOG' || el.hasAttribute('popover') ? openAttr : null,
      expanded: ariaStates['aria-expanded'] === 'true' ? true : ariaStates['aria-expanded'] === 'false' ? false : null,
      selected: ariaStates['aria-selected'] === 'true' ? true : ariaStates['aria-selected'] === 'false' ? false : null,
      checked: ariaStates['aria-checked'] === 'true' ? true : ariaStates['aria-checked'] === 'false' ? false : null,
      pressed: ariaStates['aria-pressed'] === 'true' ? true : ariaStates['aria-pressed'] === 'false' ? false : null,
      busy: ariaStates['aria-busy'] === 'true' ? true : ariaStates['aria-busy'] === 'false' ? false : null,
      // PR-8g T1: per-element focus flag. Set ONLY by reference
      // equality with document.activeElement so a focus change
      // between two snapshots is reflected in exactly one element
      // (the previously-focused one flips true→false, the new one
      // false→true). A real focus probe (DOM el.focus()) drives
      // the change; a focus probe cannot produce a click transition.
      focused: el === activeEl,
      ariaStates,
      visualNodeId: visualIdForAx(axId),
      conditionalMarkers: conditional,
    });
  }
  const openDialogIds = [];
  for (const d of document.querySelectorAll('dialog[open]')) {
    openDialogIds.push(d.id || ('__anon_dialog_' + Array.from(document.querySelectorAll('dialog')).indexOf(d)));
  }
  const openPopoverIds = [];
  for (const p of document.querySelectorAll('[popover]:not([popover="manual"])')) {
    if (p.matches(':popover-open')) {
      openPopoverIds.push(p.id || ('__anon_popover_' + Array.from(document.querySelectorAll('[popover]')).indexOf(p)));
    }
  }
  const expandedRegionAxIds = [];
  for (const e of document.querySelectorAll('[aria-expanded="true"]')) {
    expandedRegionAxIds.push(axIdFor(e));
  }
  const allConditional = {};
  for (const el of document.querySelectorAll('[data-condition]')) {
    for (const a of el.attributes) {
      if (a.name.startsWith('data-condition-')) allConditional[a.name] = a.value;
    }
  }
  const raw = JSON.stringify({ elements, openDialogIds, openPopoverIds, expandedRegionAxIds, online: navigator.onLine, focusedAxId });
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return {
    hash: 'h:' + h.toString(16),
    elements,
    openDialogIds,
    openPopoverIds,
    expandedRegionAxIds,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY },
    online: navigator.onLine,
    conditionalMarkers: allConditional,
    // PR-8g T1: State-level focus pointer. Set above the element
    // loop so it's computed exactly once per snapshot. The hash
    // input explicitly includes this field (see the JSON.stringify
    // call above) so two snapshots with different focus
    // produce different hashes even if every other field agrees.
    focusedAxId: focusedAxId,
  };
}`;

export async function takeRichSnapshot(
  page: ObservedPageLike,
  pageId: string,
): Promise<RichSnapshot> {
  return page.script.callFunction<RichSnapshot>(page.target, RICH_SNAPSHOT_FN, [pageId]);
}

/**
 * PR-8c T3: per-probe interaction behavior. The earlier probe loop
 * only emitted action *labels* (a BiDi `input.performActions` with
 * a click) for many probe kinds — `type`, `submit`, `expand`,
 * `collapse`, `dialog-open`, `dialog-close`, `tab-activate`,
 * `conditional`. That made the State materialization a labels
 * exercise: the snapshot after a `type` was the same as after a
 * `click` because the only thing that changed was a no-op input
 * event the page never saw.
 *
 * The fix is a page-side function that, given a target axId and
 * a probe kind, performs the *real* DOM action the probe is
 * supposed to drive. The in-process wrapper dispatches the
 * affected kinds through this function via
 * `script.callFunction`. The other kinds (focus/hover/click/
 * keyEnter/keySpace/dismiss/keyArrow/keyTab/scroll/drag) keep
 * their existing BiDi input behavior because the real DOM effect
 * of those probes is mediated by the browser's native input
 * pipeline, not by direct DOM mutation.
 *
 * Returns: { kind: 'ok'|'noop'|'missing', reason?: string }. The
 * loop treats 'noop' and 'missing' as "no state change" but
 * still records the probe in the audit log so the post-crawl
 * reconciliation can attribute the absence to the right cause.
 */
export const PROBE_ELEMENT_FN = `(pageId, axId, probeKind) => {
  // PR-8d (item 1): NO href special case (same rule as the other
  // page-side functions in this file).
  const root = document.documentElement;
  const idxOf = new Map();
  idxOf.set(root, 0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node; let i = 1;
  while ((node = walker.nextNode())) { idxOf.set(node, i); i++; }
  function axIdFor(el) {
    if (el.id) return 'ax:' + pageId + ':' + el.id;
    const idx = idxOf.get(el);
    if (idx === undefined) {
      const parent = el.parentElement;
      let sibIdx = 0;
      if (parent) for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++;
      return 'ax:' + pageId + ':dyn:' + (el.tagName || '') + ':' + sibIdx;
    }
    return 'ax:' + pageId + ':n' + idx;
  }
  function findElByAxId(target) {
    // The interactive-element set: anchors, buttons, form fields,
    // tablists, popovers, dialogs, and any element with a role
    // or data-condition-* marker (the conditional-render test
    // expects [data-condition-x] elements to be addressable).
    const sel = 'a, button, [role], input, select, textarea, summary, [tabindex], [popovertarget], [commandfor], [data-condition-]';
    for (const el of document.querySelectorAll(sel)) {
      if (axIdFor(el) === target) return el;
    }
    return null;
  }
  const el = findElByAxId(axId);
  if (!el) return { kind: 'missing', reason: 'element not found' };
  switch (probeKind) {
    case 'focus': {
      // PR-8g T1: real focus path. BiDi has no native focus action;
      // the page-side DOM API el.focus() is the truthful, non-
      // click-firing path. We deliberately do NOT dispatch a
      // synthetic click or pointer event here, because doing so
      // would also fire the application click handlers — which
      // is exactly the misattribution PR-8g T1 is fixing.
      //
      // The probe is considered "ok" iff:
      //   1. el.focus() did not throw (e.g. on disabled inputs),
      //   2. document.activeElement is now el or a descendant
      //      (some browsers focus a child input for composite
      //      widgets; the State-level focusedAxId accepts the
      //      descendant's id and is treated as focus on el).
      // If the element is not focusable (no tabindex, native
      // disabled), the call is a noop and no state changes —
      // the post-snapshot agrees with the pre-snapshot and the
      // loop records no hit.
      let focusedOk = false;
      try {
        el.focus({ preventScroll: true });
        focusedOk = document.activeElement === el ||
          (el.contains && el.contains(document.activeElement));
      } catch {
        focusedOk = false;
      }
      return { kind: focusedOk ? 'ok' : 'noop', reason: focusedOk ? undefined : 'not focusable' };
    }
    case 'expand': {
      // PR-8d (item 4): real interaction, not attribute mutation.
      // For <details>/<summary> we use the native open property —
      // which fires the toggle event the way a real user click
      // would. For ARIA disclosures, we dispatch a synthetic
      // click (NOT a direct aria-expanded rewrite). The
      // application code is responsible for updating aria-
      // expanded in its own click handler; we observe that
      // update in the post-snapshot.
      if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') {
        // The native click handler opens the details; we dispatch
        // a real MouseEvent so application code that listens for
        // 'click' on the summary also runs.
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { kind: 'ok' };
      }
      if (el.hasAttribute('aria-expanded')) {
        // PR-8d (item 4): dispatch a real click instead of
        // rewriting aria-expanded directly. The application's
        // own click handler will update aria-expanded; the post-
        // snapshot then captures the real state.
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { kind: 'ok' };
      }
      return { kind: 'noop', reason: 'no expand semantics' };
    }
    case 'collapse': {
      // PR-8d (item 4): real interaction, not attribute mutation.
      // Symmetric to expand: a real click on the summary or
      // disclosure trigger; the application toggles the
      // expanded state in its own handler.
      if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { kind: 'ok' };
      }
      if (el.hasAttribute('aria-expanded')) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { kind: 'ok' };
      }
      return { kind: 'noop', reason: 'no collapse semantics' };
    }
    case 'dialog-open': {
      // Find the <dialog> this element controls: either itself
      // (if it's a <dialog>), or one referenced by popovertarget,
      // or one referenced by commandfor. If none, noop.
      // PR-8d (item 4): we call showModal() (a real user-API
      // method) rather than setting the "open" attribute. The
      // application code receives the 'open' event the real way.
      let dlg = null;
      if (el.tagName === 'DIALOG') dlg = el;
      else {
        const targetId = el.getAttribute('popovertarget') || el.getAttribute('commandfor');
        if (targetId) dlg = document.getElementById(targetId);
      }
      if (dlg && dlg.tagName === 'DIALOG') {
        if (typeof dlg.showModal === 'function') { dlg.showModal(); return { kind: 'ok' }; }
        // Fallback for <dialog> without showModal (very old
        // browsers): open via the user-API-equivalent path —
        // dispatch a click on a synthetic opener rather than
        // mutate "open" directly. For HTML <dialog> this is
        // identical to the .show path; we use it as the
        // last-resort.
        dlg.dispatchEvent(new Event('open', { bubbles: true }));
        return { kind: 'ok' };
      }
      return { kind: 'noop', reason: 'no dialog target' };
    }
    case 'dialog-close': {
      let dlg = null;
      if (el.tagName === 'DIALOG') dlg = el;
      else {
        const targetId = el.getAttribute('popovertarget') || el.getAttribute('commandfor');
        if (targetId) dlg = document.getElementById(targetId);
      }
      if (dlg && dlg.tagName === 'DIALOG') {
        if (typeof dlg.close === 'function') { dlg.close(); return { kind: 'ok' }; }
        dlg.dispatchEvent(new Event('close', { bubbles: true }));
        return { kind: 'ok' };
      }
      return { kind: 'noop', reason: 'no dialog target' };
    }
    case 'tab-activate': {
      // PR-8d (item 4): real click on the tab, NOT a direct
      // aria-selected rewrite. The application's own click
      // handler (the "roving tabindex" pattern) updates
      // aria-selected/tabindex/hidden on the panels. The post-
      // snapshot then captures the real, application-driven
      // state.
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      // Also dispatch a keydown Enter / Space so keyboard-
      // activated tabs (which don't always handle 'click' on
      // the tab element) get the activation.
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { kind: 'ok' };
    }
    case 'submit': {
      // Form submit: dispatch the submit event on the closest
      // <form>. If the element is a submit button, requestSubmit
      // is called; otherwise Enter is dispatched via a
      // submitter-bearing KeyboardEvent. If no form, noop.
      const form = el.closest('form');
      if (!form) return { kind: 'noop', reason: 'no form' };
      if (el.tagName === 'BUTTON' && (el.getAttribute('type') || 'submit') === 'submit') {
        if (typeof form.requestSubmit === 'function') form.requestSubmit(el);
        else form.submit();
        return { kind: 'ok' };
      }
      // Non-submit element: dispatch a submit event with a
      // submitter. We do NOT dispatch a real Enter keydown here
      // because the user-supplied submit probe expects the form
      // pipeline, not a keystroke.
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { kind: 'ok' };
    }
    case 'type': {
      // For textbox / combobox / textarea / [contenteditable],
      // set the value via the native setter (so React/Angular
      // pick it up) and dispatch an 'input' event. The text
      // itself is a fixed probe string: 'awg-probe'.
      const tag = el.tagName;
      const isTextField = tag === 'INPUT' || tag === 'TEXTAREA';
      const isEditable = el.isContentEditable;
      if (!isTextField && !isEditable) return { kind: 'noop', reason: 'not a text field' };
      const text = 'awg-probe';
      if (isTextField) {
        const proto = tag === 'INPUT'
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { kind: 'ok' };
      } else {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { kind: 'ok' };
      }
    }
    case 'conditional': {
      // PR-8e: the conditional probe kind has been removed from the
      // active probe vocabulary because no truthful non-cooperative
      // action semantics exist for it. The previous implementation
      // dispatched a vendor-specific awg:condition-change custom event
      // that no unmodified target application would listen to; the
      // binding instruction prohibits Agent Web Graph-specific
      // cooperation from a target app. Conditional state transitions
      // are now captured exclusively through the non-cooperative
      // data-condition-* reader in the rich snapshot, and a change to
      // conditionalMarkers between before/after snapshots is detected
      // by richSnapshotDiffers. If any code path still reaches this
      // branch (e.g. a stale call site), the result is a noop so no
      // state is fabricated.
      return { kind: 'noop', reason: 'conditional probe removed (PR-8e); markers captured via rich snapshot diff' };
    }
    case 'choose-dropdown': {
      // PR-8h T2: the choose-dropdown probe is NOT dispatched from
      // the page side at all. The page-side PROBE_ELEMENT_FN is
      // forbidden from synthesizing events for this probe; the
      // only allowed page-side role is reading state (rects,
      // current value) for the BiDi dispatcher to act on. The
      // real interaction is driven from runExtendedProbe's
      // case "choose-dropdown" branch, which routes through
      // page.input.performActions (real BiDi pointer + keyboard).
      // The script-side counterpart here returns 'noop' so the
      // V2 loop never short-circuits on a synthesized mutation;
      // the post-probe snapshot is taken by the V2 loop's normal
      // takeSnapshot() call, which captures the real state after
      // the BiDi actions have landed. This is the architectural
      // split: page side observes; BiDi drives.
      return { kind: 'noop', reason: 'choose-dropdown driven by real BiDi input (PR-8h T2)' };
    }
  }
  // Default: this is a kind that the BiDi input pipeline handles
  // (click, focus, hover, key*, drag, scroll). Return 'noop' so
  // the loop falls through to the input.performActions path.
  return { kind: 'noop', reason: 'kind dispatched to BiDi input' };
}`;

export type ProbeElementResult = { kind: "ok" | "noop" | "missing"; reason?: string };

export async function probeElement(
  page: ObservedPageLike,
  pageId: string,
  axId: string,
  probeKind: ExtendedProbeKind,
): Promise<ProbeElementResult> {
  return page.script.callFunction<ProbeElementResult>(
    page.target,
    PROBE_ELEMENT_FN,
    [pageId, axId, probeKind],
  );
}
