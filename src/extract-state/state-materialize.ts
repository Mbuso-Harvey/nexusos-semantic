/**
 * Shared State-node materializer.
 *
 * **PR-8b (items 1, 2, 4, 7, 8).** Before PR-8b, state materialization
 * was:
 *   - The observed extractor's `materializeStates()` discarded the
 *     real `before` and `after` `RichSnapshot`s, kept only their
 *     hashes, and then reconstructed a fake after-state by toggling
 *     `expanded` and `selected` on the baseline. (Item 1 — fixed.)
 *   - The declared extractor never produced a `StateNode` at all;
 *     the `declared+observed` convergence flag in
 *     `graph.upsertState` was dead code. (Item 2 — fixed.)
 *   - The `state:cause` resolver fell back to "first state on the
 *     same page" when no evidence existed, falsely connecting
 *     unresolved edges. (Item 4 — fixed.)
 *   - `state:visual`, `state:auth`, and `state-feeds-capability`
 *     edges were never emitted. (Item 7/8 — fixed.)
 *
 * This module is the single source of truth for both the declared
 * and the observed paths. It:
 *   - Builds a `StatePayload` from a real `RichSnapshot`.
 *   - Computes the canonical `StateNode.id` via `deriveStateId`.
 *   - Upserts the `StateNode` (the `graph.upsertState` convergence
 *     logic unions the new evidence with the existing one and
 *     promotes the kind to `"declared+observed"` when both are
 *     present).
 *   - Emits the cross-layer edges: `state:on-page`,
 *     `state:of-element` (one per element in the payload),
 *     `state:visual` (when an observation has a real `visualNodeId`),
 *     `state:auth` (one per state, to the auth-context id), and
 *     `state-feeds-capability` (only when the source axId is the
 *     binding of a `Capability` already in the graph — explicit
 *     evidence only, per ED-01 2E).
 *   - For `materializeSuccessor`, writes the `state:successor` edge
 *     between the before-state and the after-state with the
 *     trigger that caused the transition.
 *   - For `resolveStateCauseEdges`, removes (NOT re-points at a
 *     random state) any unresolved `state:cause` edge and emits a
 *     log line via the optional `onUnresolved` callback so the
 *     caller can surface a warning.
 */
import type {
  AuthContext, NetworkContext, Edge, TransitionTrigger, StateEvidence, StateEvidenceKind,
  ElementStateObservation, StatePayload, Provenance,
} from "../graph/types.js";
import type { AuthSpec } from "../crawler/auth.js";
import type { Page } from "../bidi-client/page.js";
import type { Graph } from "../graph/graph.js";
import { buildStatePayload, deriveStateId, computeVisualFingerprint } from "../graph/state-id.js";
import { applyAuthSpec } from "../crawler/auth.js";

// ----- Public types -----

/** Minimal rich snapshot shape consumed by the materializer. */
export interface MaterializeSnapshot {
  /** Per-element observations, keyed by canonical axId. */
  elements: Record<string, ElementStateObservation>;
  /**
   * PR-8g T1: axId of the currently-focused element (or null). The
   * per-element `focused` flag in `elements[axId].focused` and the
   * State-level `focusedAxId` must agree — if a focus change is
   * recorded, exactly one element has `focused=true` and
   * `focusedAxId === that.axId`. The materializer reads the State-
   * level field for the StatePayload and per-element `focused` for
   * the ElementStateObservation; the rich snapshot already enforces
   * this consistency (the page-side walker sets both from the same
   * `document.activeElement`).
   */
  focusedAxId: string | null;
  /** Currently-open `<dialog>` ids. */
  openDialogIds: string[];
  /** Currently-open `[popover]` ids. */
  openPopoverIds: string[];
  /** axIds of regions where `aria-expanded="true"`. */
  expandedRegionAxIds: string[];
  /** Viewport state. */
  viewport: { w: number; h: number; dpr: number; scrollX: number; scrollY: number };
  /** `data-condition-*` markers observed on visible elements. */
  conditionalMarkers?: Record<string, string>;
}

/** The result of a single state materialization. */
export interface MaterializeResult {
  /** The canonical id of the upserted state. */
  stateId: string;
  /** The ids of cross-layer edges emitted by this call. */
  edgeIds: string[];
}

/** Options for `materializeSuccessor` (a before/after transition). */
export interface MaterializeSuccessorOptions {
  graph: Graph;
  pageId: string;
  route: string;
  auth: AuthContext;
  network: NetworkContext;
  before: MaterializeSnapshot;
  after: MaterializeSnapshot;
  /** axId of the element whose probe caused the transition (used as
   *  the source for `state:of-element` / `state:visual`). */
  sourceAxId: string;
  /** The trigger that fired the transition. */
  trigger: TransitionTrigger;
  /** The evidence kind (declared for declared paths, observed for
   *  the observed probe loop). `graph.upsertState` will union with
   *  any existing evidence and may promote to
   *  `"declared+observed"`. */
  evidenceKind: StateEvidenceKind;
  /** Provenance for the new edges. */
  provenance: "html:parse" | "dom-diff:probe" | "bidi:network";
  /** ISO 8601 timestamp (default: now). */
  at?: string;
}

// ----- Public surface -----

/**
 * Derive a stable id for the auth context of a state. Used for the
 * `state:auth` edge's `to` field. The format is
 * `auth:<kind>:<principal>:<session>` for authenticated kinds and
 * `auth:anonymous` for the anonymous kind.
 */
export function authIdFor(a: AuthContext): string {
  switch (a.kind) {
    case "anonymous":
      return "auth:anonymous";
    case "authenticated":
      return `auth:authenticated:${a.principal}:${a.session}`;
    case "administrator":
      return `auth:administrator:${a.principal}:${a.session}`;
    case "custom-role":
      return `auth:custom-role:${a.role}:${a.principal}:${a.session}`;
  }
}

/**
 * Materialize a single state from a real rich snapshot. Returns the
 * canonical state id and the cross-layer edge ids that were written.
 * The graph is mutated in place; idempotent on state id.
 */
export function materializeState(
  graph: Graph,
  pageId: string,
  route: string,
  auth: AuthContext,
  network: NetworkContext,
  snapshot: MaterializeSnapshot,
  sourceAxIds: string[],
  evidence: StateEvidence,
  provenance: "html:parse" | "dom-diff:probe" | "bidi:network",
): MaterializeResult {
  const payload = buildStatePayload({
    pageId,
    route,
    auth,
    network,
    elements: snapshot.elements,
    focusedAxId: snapshot.focusedAxId,
    openDialogIds: snapshot.openDialogIds,
    openPopoverIds: snapshot.openPopoverIds,
    expandedRegionAxIds: snapshot.expandedRegionAxIds,
    viewport: snapshot.viewport,
    conditionalMarkers: snapshot.conditionalMarkers ?? {},
  });
  const id = deriveStateId(payload);
  const visualFingerprint = computeVisualFingerprint(payload);
  graph.upsertState({
    id,
    type: "state",
    pageId,
    payload,
    visualFingerprint,
    authContext: auth,
    networkContext: network,
    provenance,
    firstObservedAt: evidence.at,
    evidence: [evidence],
  });
  const edgeIds: string[] = [];
  // state:on-page — one per state.
  const onPageEdgeId = `edge:${id}->${pageId}:state:on-page`;
  graph.upsertEdge({
    id: onPageEdgeId,
    type: "edge",
    from: id,
    to: pageId,
    kind: "state:on-page",
    provenance,
  });
  edgeIds.push(onPageEdgeId);
  // state:of-element — one per source axId in the elements map.
  for (const axId of sourceAxIds) {
    if (!snapshot.elements[axId]) continue;
    const eId = `edge:${id}->${axId}:state:of-element`;
    graph.upsertEdge({
      id: eId,
      type: "edge",
      from: id,
      to: axId,
      kind: "state:of-element",
      provenance,
    });
    edgeIds.push(eId);
  }
  // state:visual — emitted when the source axId has a real visualNodeId
  // AND that VisualNode is present in the graph (PR-8c T2: no dangling
  // visual edges). We resolve the visual id two ways:
  //   - If `obs.visualNodeId` is set and a VisualNode with that id
  //     exists in the graph, use it.
  //   - Otherwise, look up by `graph.visualByAx(axId)` so the
  //     structural-walk-based VisualNode that the visual extractor
  //     produced for the same axId resolves correctly.
  // If neither lookup finds a node, the edge is omitted (no dangling
  // reference; the state node is still complete).
  for (const axId of sourceAxIds) {
    const obs = snapshot.elements[axId];
    let visId: string | null = null;
    if (obs && obs.visualNodeId && graph.getVisual(obs.visualNodeId)) {
      visId = obs.visualNodeId;
    } else {
      const vis = graph.visualByAx(axId);
      if (vis) visId = vis.id;
    }
    if (visId) {
      const eId = `edge:${id}->${visId}:state:visual`;
      graph.upsertEdge({
        id: eId,
        type: "edge",
        from: id,
        to: visId,
        kind: "state:visual",
        provenance,
      });
      edgeIds.push(eId);
    }
  }
  // state:auth — one per state. PR-8c T6: the AuthContextNode is
  // upserted FIRST so the `state:auth` edge's `to` always points at
  // a real graph entity (no dangling edges). The id is the same
  // string the old `authIdFor` produced, so existing code that
  // computed that id still finds a graph node.
  const authNodeId = authIdFor(auth);
  graph.upsertAuthContext({
    id: authNodeId,
    type: "auth-context",
    context: auth,
    firstObservedAt: evidence.at,
    observationCount: 0,
    provenance,
  });
  const authEdgeId = `edge:${id}->${authNodeId}:state:auth`;
  graph.upsertEdge({
    id: authEdgeId,
    type: "edge",
    from: id,
    to: authNodeId,
    kind: "state:auth",
    provenance,
  });
  edgeIds.push(authEdgeId);
  // state-feeds-capability — emitted only when the source axId is
  // the binding axId of a `Capability` already in the graph
  // (ED-01 2E: explicit evidence only, no speculation).
  for (const axId of sourceAxIds) {
    for (const cap of graph.capabilities()) {
      if (cap.binding.kind === "ax-node" && cap.binding.axId === axId) {
        const eId = `edge:${id}->${cap.id}:state-feeds-capability`;
        graph.upsertEdge({
          id: eId,
          type: "edge",
          from: id,
          to: cap.id,
          kind: "state-feeds-capability",
          provenance,
        });
        edgeIds.push(eId);
      }
    }
  }
  return { stateId: id, edgeIds };
}

/**
 * Materialize a before-state and an after-state, and write the
 * `state:successor` edge between them with the trigger. The
 * before-state is always emitted (it's the "page in its
 * pre-transition state"). The after-state is emitted only when
 * `after` is different from `before` (different payload). The
 * convergence logic in `graph.upsertState` runs on both.
 */
export function materializeSuccessor(opts: MaterializeSuccessorOptions): {
  beforeId: string;
  afterId: string;
  edgeId: string | null;
} {
  const at = opts.at ?? new Date().toISOString();
  const beforeSourceAxIds = Object.keys(opts.before.elements);
  const afterSourceAxIds = Object.keys(opts.after.elements);
  // The source axId is the one whose observation actually carries
  // the change. If the caller provides one, include it in both
  // source-axId lists so it is always wired to a `state:of-element`
  // edge.
  const beforeSet = new Set([...beforeSourceAxIds, opts.sourceAxId]);
  const afterSet = new Set([...afterSourceAxIds, opts.sourceAxId]);
  const beforeResult = materializeState(
    opts.graph, opts.pageId, opts.route, opts.auth, opts.network,
    opts.before, [...beforeSet], {
      kind: opts.evidenceKind,
      sourceAxId: opts.sourceAxId,
      transitionId: null,
      at,
    }, opts.provenance,
  );
  const afterResult = materializeState(
    opts.graph, opts.pageId, opts.route, opts.auth, opts.network,
    opts.after, [...afterSet], {
      kind: opts.evidenceKind,
      sourceAxId: opts.sourceAxId,
      transitionId: null,
      at,
    }, opts.provenance,
  );
  let edgeId: string | null = null;
  if (beforeResult.stateId !== afterResult.stateId) {
    edgeId = `edge:${beforeResult.stateId}->${afterResult.stateId}:state:successor`;
    opts.graph.upsertEdge({
      id: edgeId,
      type: "edge",
      from: beforeResult.stateId,
      to: afterResult.stateId,
      kind: "state:successor",
      provenance: opts.provenance,
      triggers: [opts.trigger],
    });
  }
  return { beforeId: beforeResult.stateId, afterId: afterResult.stateId, edgeId };
}

// ----- PR-8h T3: causal auth transition -----

/**
 * PR-8h T3: causal auth transition. Wires an explicit
 * `anonymous State A → authenticated State B` edge based on a
 * real, in-order, sequential flow:
 *
 *   1. Open the page under the anonymous context.
 *   2. Run the observed extractor → State A (auth = anonymous).
 *   3. Call `applyAuthSpec(page, spec, baseUrl)` to set the
 *      session cookie via real BiDi `storage.setCookies`.
 *   4. Run the observed extractor AGAIN on the same page →
 *      State B (auth = authenticated / administrator / custom-role).
 *   5. Hand the (A, B) pair to this function. It emits the
 *      `state:successor` edge with `triggers: ["auth"]` and
 *      `provenance` set to the actual BiDi call that drove the
 *      transition (`bidi:storage.setCookies`).
 *
 * This is the explicit (A, B) wiring. It does NOT pair states
 * across independent crawls and does NOT use a field-by-field
 * `findAuthTwin` heuristic. The orchestrator produces the (A, B)
 * pair; this materializer just wires it.
 *
 * **Constraints (enforced).**
 *   - `beforeAuth.kind` MUST be `"anonymous"`. A non-anonymous
 *     `beforeAuth` is a programming error in the orchestrator and
 *     the function returns 0 (no edge emitted) with a console
 *     warning. We refuse to emit an `auth` edge whose `from` is
 *     already authenticated — that would be a re-auth, not an
 *     anonymous→authenticated transition, and re-auth is not in
 *     the PR-8h blocker 2 acceptance.
 *   - `afterAuth.kind` MUST NOT be `"anonymous"`. An anonymous
 *     `afterAuth` means the auth spec did not change the
 *     context; emitting an `auth` edge with no real change is
 *     dishonest.
 *   - `from` and `to` MUST be distinct state ids.
 *   - The edge is idempotent: the same (from, to, provenance,
 *     triggers) tuple produces the same deterministic edge id
 *     (`edge:{from}->{to}:state:successor`); a second call does
 *     not double-emit.
 *
 * @returns The number of edges emitted (0 or 1).
 */
export function materializeCausalAuthTransition(opts: {
  graph: Graph;
  fromStateId: string;
  toStateId: string;
  beforeAuth: AuthContext;
  afterAuth: AuthContext;
  provenance: Provenance;
}): number {
  if (opts.beforeAuth.kind !== "anonymous") {
    console.warn(
      `[materializeCausalAuthTransition] refusing to emit auth edge: ` +
      `fromState ${opts.fromStateId} has non-anonymous auth ` +
      `${JSON.stringify(opts.beforeAuth)}. ` +
      `PR-8h T3 only supports anonymous → {authenticated, administrator, custom-role}.`,
    );
    return 0;
  }
  if (opts.afterAuth.kind === "anonymous") {
    console.warn(
      `[materializeCausalAuthTransition] refusing to emit auth edge: ` +
      `toState ${opts.toStateId} has anonymous auth. ` +
      `The transition must be to a non-anonymous context.`,
    );
    return 0;
  }
  if (opts.fromStateId === opts.toStateId) {
    console.warn(
      `[materializeCausalAuthTransition] refusing to emit self-edge ` +
      `${opts.fromStateId} -> ${opts.toStateId}.`,
    );
    return 0;
  }
  const edgeId = `edge:${opts.fromStateId}->${opts.toStateId}:state:successor`;
  const alreadyExisted = opts.graph.getEdge(edgeId) !== undefined;
  opts.graph.upsertEdge({
    id: edgeId,
    type: "edge",
    from: opts.fromStateId,
    to: opts.toStateId,
    kind: "state:successor",
    provenance: opts.provenance,
    triggers: ["auth"],
  });
  return alreadyExisted ? 0 : 1;
}

// ----- PR-8i T1: same-page causal auth flow -----

/**
 * PR-8i T1 (real same-page causal auth).
 *
 * PR-8h T3 wired a `state:successor` edge from the anonymous state
 * to the authenticated state, but the orchestrator it relied on
 * (see `src/crawler/orchestrator.ts` `URL × auth-context` loop)
 * opens a **separate `Page` per auth context** and pairs State A
 * and State B after the fact. That is the matrix-twin inference
 * the PR-8i directive explicitly calls out: the two State nodes
 * never coexisted on the same browser session, so the edge
 * "anonymous → authenticated" is a derivation, not a causal
 * observation.
 *
 * `runCausalAuthFlow` is the corrective. It accepts a SINGLE live
 * `Page` and runs the full in-order sequence on it:
 *
 *   1. `await page.navigate(route)` — load the page under the
 *      **anonymous** context (the cookies from any prior
 *      authenticated context were never set, or were cleared
 *      by a prior test step).
 *   2. `runObservedExtractor` → State A (auth = anonymous).
 *   3. `applyAuthSpec(page, spec, baseUrl)` — real BiDi
 *      `storage.setCookies` (PR-8d: cookies written to the BiDi
 *      cookie jar; the page reads them on the next navigation).
 *   4. `await page.reload()` — same-page reload so the page's
 *      JavaScript sees the new cookies and the rendered DOM
 *      reflects the authenticated context.
 *   5. `runObservedExtractor` → State B (auth = authenticated /
 *      administrator / custom-role).
 *   6. `materializeCausalAuthTransition({ fromStateId, toStateId,
 *      beforeAuth, afterAuth, provenance: "bidi:storage.setCookies" })`
 *      — emits the `state:successor` edge with `triggers: ["auth"]`
 *      and provenance = the actual BiDi call.
 *
 * The function signature takes a single `Page` so the type system
 * prevents the matrix-twin defect from creeping back in. Callers
 * CANNOT pass two different `Page` objects to this function and
 * re-introduce the original anti-pattern.
 *
 * **Constraints.**
 *   - `spec.kind` MUST be one of `authenticated`, `administrator`,
 *     `custom-role`. `anonymous` is a no-op (the auth context did
 *     not change, so no transition occurred).
 *   - State A and State B MUST have different canonical ids
 *     (the auth field is part of the canonical state-id per
 *     `deriveStateId`). If they do not, the function returns
 *     `{ fromStateId, toStateId, edgeEmitted: 0 }` with a
 *     warning: the page did not actually reflect the new auth
 *     context (likely a BiDi cookie jar mismatch).
 *   - The function does NOT touch the orchestrator's per-context
 *     iteration. The orchestrator's `URL × auth-context` loop is
 *     still useful for exploring per-context state graphs, but
 *     the AUTH transition is now this function's responsibility
 *     (real, same-page, causal).
 *
 * @returns `{ fromStateId, toStateId, edgeEmitted }`. The two ids
 *   are the canonical state ids of A and B. `edgeEmitted` is 1
 *   when a new edge was written, 0 when the (A, B) pair was
 *   already present (idempotent re-run) or the auth context did
 *   not actually change.
 */
export async function runCausalAuthFlow(opts: {
  graph: Graph;
  page: Page;
  pageId: string;
  route: string;
  spec: AuthSpec;
  baseUrl: string;
  log?: (msg: string) => void;
  network?: NetworkContext;
}): Promise<{ fromStateId: string; toStateId: string; edgeEmitted: number }> {
  const log = opts.log ?? (() => undefined);
  const network: NetworkContext = opts.network ?? { status: "online", evidence: "page-instrumented" };
  // PR-8i T1: refuse the spec that would not produce a real auth
  // transition. `anonymous` means "no auth change"; the function
  // returns a sentinel pair with edgeEmitted = 0.
  if (opts.spec.kind === "anonymous") {
    log("[runCausalAuthFlow] spec.kind=anonymous is a no-op; returning empty result");
    return { fromStateId: "", toStateId: "", edgeEmitted: 0 };
  }
  // PR-8i T1: the spec must produce a non-anonymous AuthContext.
  // Build the post-auth AuthContext from the spec — this is the
  // shape `materializeState` expects.
  const afterAuth: AuthContext = (() => {
    if (opts.spec.kind === "authenticated") {
      return { kind: "authenticated", principal: opts.spec.principal, session: opts.spec.session };
    }
    if (opts.spec.kind === "administrator") {
      return { kind: "administrator", principal: opts.spec.principal, session: opts.spec.session };
    }
    // custom-role
    return { kind: "custom-role", role: opts.spec.role, principal: opts.spec.principal, session: opts.spec.session };
  })();
  // Step 1: navigate to the page under the anonymous context.
  // (Callers are expected to have already done this; we re-navigate
  // defensively so the flow is idempotent and self-contained.)
  await opts.page.navigate(opts.route);
  // Step 2: capture State A. The observed extractor is the
  // production path; it takes a real BiDi `RichSnapshot` via
  // `page.script.callFunction` and materializes the canonical
  // state id (auth = anonymous at this point).
  // Dynamic import to break the observed.ts ↔ state-materialize.ts
  // circular import (observed.ts imports from this file at the
  // top level; we import observed at call time only).
  const { runObservedExtractor } = await import("./observed.js");
  const beforeAuth: AuthContext = { kind: "anonymous" };
  const beforeResult = await runObservedExtractor(
    opts.graph, opts.page, opts.pageId,
    (msg) => log(`[before-auth] ${msg}`),
    { auth: beforeAuth, network },
  );
  const fromStateId = beforeResult.result
    ? firstStateIdFor(opts.graph, opts.pageId, beforeAuth)
    : "";
  if (!fromStateId) {
    log("[runCausalAuthFlow] before-state did not materialize; aborting");
    return { fromStateId: "", toStateId: "", edgeEmitted: 0 };
  }
  // Step 3: apply the auth spec — real BiDi cookies.
  const applied = await applyAuthSpec(opts.page, opts.spec, opts.baseUrl);
  // The applied.context is the ground-truth post-auth AuthContext
  // (PR-8d: this is what `page.storage.getCookies` would confirm;
  // the returned AppliedAuth carries the same shape the extractor
  // expects).
  void applied;
  // Step 4: reload the same page so the JS sees the new cookies.
  await opts.page.reload();
  // Step 5: capture State B. The post-auth extractor uses the
  // post-auth AuthContext so the canonical state id reflects the
  // new context.
  const afterResult = await runObservedExtractor(
    opts.graph, opts.page, opts.pageId,
    (msg) => log(`[after-auth] ${msg}`),
    { auth: afterAuth, network },
  );
  const toStateId = afterResult.result
    ? firstStateIdFor(opts.graph, opts.pageId, afterAuth)
    : "";
  if (!toStateId) {
    log("[runCausalAuthFlow] after-state did not materialize; aborting");
    return { fromStateId, toStateId: "", edgeEmitted: 0 };
  }
  // Step 6: wire the explicit (A, B) pair. The provenance is the
  // actual BiDi call that drove the transition (the cookie write
  // is what caused the JS to re-render under the new context).
  const edgeEmitted = materializeCausalAuthTransition({
    graph: opts.graph,
    fromStateId,
    toStateId,
    beforeAuth,
    afterAuth,
    provenance: "bidi:storage.setCookies",
  });
  log(
    `[runCausalAuthFlow] emitted ${edgeEmitted} edge ` +
    `(${fromStateId.slice(0, 24)}… --auth--> ${toStateId.slice(0, 24)}…)`,
  );
  return { fromStateId, toStateId, edgeEmitted };
}

/**
 * PR-8i T1 helper. Find the first `StateNode` on the given page
 * whose auth context matches `auth`. The state id is canonical
 * (includes auth), so this lookup is a structural one: a state
 * produced by `runObservedExtractor(graph, page, pageId, log,
 * { auth })` will have `payload.auth === auth` and a matching id.
 *
 * Returns `""` if no such state exists.
 */
function firstStateIdFor(
  graph: Graph,
  pageId: string,
  auth: AuthContext,
): string {
  for (const s of graph.states()) {
    if (s.pageId !== pageId) continue;
    if (s.payload.auth.kind !== auth.kind) continue;
    if (auth.kind === "anonymous") return s.id;
    // Per-kind narrowing. Cast the two sides to the same narrowed
    // union so TS sees matching `principal` / `session` access.
    if (auth.kind === "authenticated" || auth.kind === "administrator") {
      const a = s.payload.auth as { kind: typeof auth.kind; principal: string; session: string };
      const b = auth as { kind: typeof auth.kind; principal: string; session: string };
      if (a.principal === b.principal && a.session === b.session) return s.id;
    }
    if (auth.kind === "custom-role") {
      const a = s.payload.auth as { kind: typeof auth.kind; role: string; principal: string; session: string };
      const b = auth as { kind: typeof auth.kind; role: string; principal: string; session: string };
      if (a.role === b.role &&
          a.principal === b.principal &&
          a.session === b.session) {
        return s.id;
      }
    }
  }
  return "";
}

// ----- state:cause resolution (item 4: no false fallback) -----

/**
 * Resolve every `state:cause` edge in the graph whose `to` starts
 * with `state:TBD:` (a placeholder from PR-8a) by replacing the
 * placeholder with the real State id that references the same
 * source axId.
 *
 * **Item 4 (PR-8b).** The old resolver fell back to "first state on
 * the same page" when no matching State was found. That was a false
 * connection: an unresolved `state:cause` edge is not a transition
 * — it is an absence of evidence. The new behavior:
 *
 *   - If a State node on the same page has the source axId in its
 *     `payload.elements`, the `state:cause` edge is re-pointed at
 *     that State.
 *   - Otherwise, the `state:cause` edge is **removed** (not
 *     re-pointed) and the `onUnresolved` callback is called with
 *     the source axId and the placeholder id so the caller can log
 *     a `[state-cause-unresolved]` warning.
 *
 * The `pageResolver` argument is the page id for the source axId;
 * pass `graph.getAx(axId)?.pageId ?? ""` to look it up.
 */
export function resolveStateCauseEdges(
  graph: Graph,
  onUnresolved?: (info: { sourceAxId: string; placeholderStateId: string; pageId: string }) => void,
): { resolved: number; unresolved: number; removed: number } {
  // Snapshot the unresolved edges first so we can mutate the graph
  // without invalidating the iterator. PR-8d T7: we also capture the
  // structural `cause` field so the resolver can read declaredKind
  // / commandValue directly without parsing the placeholder id.
  const unresolved: Array<{
    edgeId: string; from: string; to: string;
    cause: Edge["cause"];
  }> = [];
  for (const e of graph.allEdges()) {
    if (e.kind !== "state:cause") continue;
    if (!e.to.startsWith("state:TBD:")) continue;
    unresolved.push({ edgeId: e.id, from: e.from, to: e.to, cause: e.cause });
  }
  if (unresolved.length === 0) return { resolved: 0, unresolved: 0, removed: 0 };

  // PR-8c T7: pre-index every State node's evidence by sourceAxId so
  // we can find the SPECIFIC State (not just any matching state) that
  // was caused by this source axId. The placeholder is resolved by
  // walking: source axId → StateEvidence (with trigger) → State node
  // → state:successor edge → after-state. The before-state of that
  // transition is the causally linked target.
  const statesByEvidence: Map<string, Array<{
    stateId: string;
    transitionId: string | null;
  }>> = new Map();
  for (const s of graph.states()) {
    for (const ev of s.evidence) {
      const list = statesByEvidence.get(ev.sourceAxId) ?? [];
      list.push({ stateId: s.id, transitionId: ev.transitionId });
      statesByEvidence.set(ev.sourceAxId, list);
    }
  }

  // Pre-index every state:successor edge so we can resolve
  // "beforeState -> afterState" pairs by their (from, to) keys.
  const successorsByFrom = new Map<string, Array<{ to: string; triggers: string[] }>>();
  for (const e of graph.allEdges()) {
    if (e.kind !== "state:successor") continue;
    const list = successorsByFrom.get(e.from) ?? [];
    list.push({ to: e.to, triggers: e.triggers ?? [] });
    successorsByFrom.set(e.from, list);
  }

  let resolvedCount = 0;
  let removedCount = 0;
  for (const e of unresolved) {
    // PR-8d T7: the resolver no longer parses the placeholder string
    // (`e.to.split(":")[3]`) — that approach was ambiguous and
    // index-fragile. The Edge's structural `cause` field carries the
    // kind and commandValue directly (see declared.ts:654-668 where
    // the cause record is attached on emission).
    //
    // Resolution still walks the evidence chain (sourceAxId →
    // StateEvidence → State → state:successor) — the difference is
    // that the declared kind is now read from `e.cause.declaredKind`
    // rather than parsed out of the placeholder id.
    const sourceAxId = e.from;
    const sourceAx = graph.getAx(sourceAxId);
    const pageId = sourceAx?.pageId ?? "";
    const declaredKind: string | null = e.cause?.declaredKind ?? null;
    const commandValue: string | null = e.cause?.commandValue ?? null;

    // Step 1: find the State node whose evidence names this source axId.
    const evidenceMatches = statesByEvidence.get(sourceAxId) ?? [];
    let beforeStateId: string | null = null;
    for (const m of evidenceMatches) {
      const s = graph.getState(m.stateId);
      if (!s || s.pageId !== pageId) continue;
      // Step 2: find the state:successor edge FROM this state. If
      // there is one, the source axId was a real cause of a transition.
      const succs = successorsByFrom.get(s.id) ?? [];
      if (succs.length === 0) continue;
      // Pick the successor whose trigger matches the declared kind
      // (if known). Otherwise pick the first.
      let chosen = succs[0]!;
      if (declaredKind) {
        const match = succs.find((s2) =>
          s2.triggers.some((t) => t.toLowerCase().includes(declaredKind.toLowerCase()))
        );
        if (match) chosen = match;
      }
      beforeStateId = s.id;
      // The follow-on state (chosen.to) is reachable from this
      // before-state via the state:successor edge.
      break;
    }
    if (beforeStateId) {
      // Re-point the edge by upserting a new edge with the same id
      // (the graph is idempotent on edge id; the upsert overwrites).
      // PR-8d T7: the structural `cause` field is preserved on the
      // resolved edge so consumers can read declaredKind /
      // commandValue without re-parsing.
      graph.upsertEdge({
        id: e.edgeId,
        type: "edge",
        from: e.from,
        to: beforeStateId,
        kind: "state:cause",
        provenance: "html:parse",
        cause: {
          sourceAxId,
          declaredKind: (declaredKind ?? "commandfor") as NonNullable<Edge["cause"]>["declaredKind"],
          commandValue: commandValue ?? undefined,
        },
      });
      resolvedCount++;
    } else {
      // No causal evidence. Remove the edge via the public
      // `removeEdge` method (PR-8b item 4: no false fallback). The
      // graph's secondary indexes are also updated.
      graph.removeEdge(e.edgeId);
      removedCount++;
      if (onUnresolved) {
        onUnresolved({ sourceAxId, placeholderStateId: e.to, pageId });
      }
    }
  }
  return { resolved: resolvedCount, unresolved: unresolved.length, removed: removedCount };
}
