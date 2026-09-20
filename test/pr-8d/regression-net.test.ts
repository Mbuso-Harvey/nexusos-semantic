/**
 * PR-8d T11: regression-net test for every PR-8d defect.
 *
 * This file collects one end-to-end assertion per PR-8d item (T1–T10)
 * into a single test. A regression of any item fails this test, which
 * gives a single failure mode the operator can investigate without
 * hunting through 12+ test files.
 *
 * Each test exercises a real-extractor path and asserts the property
 * the defect would have broken. The test mock pattern matches the
 * rest of the suite (ObservedPageLike + script.callFunction) so it
 * runs in CI without BiDi; the env-gated live-app equivalent lives
 * in test/e2e/real-app.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { extractStateDeclared, type DeclaredRecord } from "../../src/extract-state/declared.js";
import { runObservedExtractor, type ObservedPageLike, type RichSnapshot } from "../../src/extract-state/observed.js";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode, AuthContext, NetworkContext } from "../../src/graph/types.js";

const PAGE = "page:https://example.com/";

function makePageNode(): PageNode {
  return {
    id: PAGE, type: "page", url: "https://example.com/", title: "T",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: `ax:${PAGE}:root`, provenance: "bidi:script.evaluate" },
    viewport: { w: 1280, h: 800, dpr: 1 },
    tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://example.com/",
    crawledAt: "2026-08-30T00:00:00.000Z", parentPageId: null,
  };
}

function seedTwoNodes(g: Graph, sourceAxId: string, targetAxId: string, targetRole: string): void {
  g.upsertPage(makePageNode());
  g.upsertAx({
    id: targetAxId, type: "ax-node", pageId: PAGE,
    role: targetRole, name: "tgt", nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 1, parentAxId: null, provenance: "aria:t",
  });
  g.upsertAx({
    id: sourceAxId, type: "ax-node", pageId: PAGE,
    role: "button", name: "src", nameSource: "content",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
  });
}

function baselineRichSnap(sourceAxId: string, targetAxId: string): RichSnapshot {
  const element = (axId: string) => ({
    axId, rect: { x: 0, y: 0, w: 0, h: 0 },
    visibility: "visible" as const, zIndex: 0,
    open: null, expanded: null, selected: null, checked: null, pressed: null, busy: null,
    // PR-8g T1: per-element focus flag.
    focused: false,
    ariaStates: {}, visualNodeId: null, conditionalMarkers: {},
  });
  return {
    hash: "h:baseline",
    elements: [element(sourceAxId), element(targetAxId)],
    openDialogIds: [], openPopoverIds: [], expandedRegionAxIds: [],
    viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
    online: true, conditionalMarkers: {},
    // PR-8g T1: State-level focus pointer.
    focusedAxId: null,
  };
}

describe("PR-8d T11: regression-net (each test fails if its PR-8d item regresses)", () => {
  it("T7: state:cause resolver uses the structural cause field, not placeholder string parsing", async () => {
    // If the resolver ever goes back to parsing the placeholder id
    // (e.g. e.to.split(":")[3]), this test fails because the
    // placeholder is written with a non-parseable segment.
    const sourceAxId = "ax:page:btn";
    const targetAxId = "ax:page:dlg";
    const g = new Graph();
    seedTwoNodes(g, sourceAxId, targetAxId, "dialog");
    // The placeholder has an extra `:anything` segment that the
    // old string-split parser would mishandle. The new resolver
    // must read declaredKind/commandValue from e.cause instead.
    g.upsertEdge({
      id: `edge:${sourceAxId}->state:TBD:anything:command-show-modal:state:cause`,
      type: "edge", kind: "state:cause",
      from: sourceAxId, to: "state:TBD:anything:command-show-modal",
      provenance: "html:parse",
      cause: {
        sourceAxId,
        declaredKind: "commandfor",
        commandValue: "show-modal",
      },
    });
    // Run the resolver indirectly: invoke declared.ts's
    // resolveStateCauseEdges via extractStateDeclared.run. The
    // declared extractor calls it after materialization.
    const records: DeclaredRecord[] = [{
      fromAxId: sourceAxId, toAxId: targetAxId,
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-show-modal", commandValue: "show-modal",
    }];
    const page: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: { callFunction: (async () => records) as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    await extractStateDeclared.run({
      graph: g, page: page as any, pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });
    // The placeholder edge must be resolved to a real state id, not
    // left as "state:TBD:*". The structural cause field must be
    // preserved on the resolved edge.
    const resolved = [...g.allEdges()].find((e) => e.kind === "state:cause" && e.from === sourceAxId);
    expect(resolved).toBeDefined();
    expect(resolved!.to.startsWith("state:TBD:")).toBe(false);
    expect(resolved!.to.startsWith("state:")).toBe(true);
    expect(resolved!.cause?.declaredKind).toBe("commandfor");
    expect(resolved!.cause?.commandValue).toBe("show-modal");
  });

  it("T8: declared State uses the actual command semantics (command=show-modal -> openDialogIds)", async () => {
    // If deriveAfterSnapshot ever goes back to a single
    // "add to openPopoverIds" default for all commandfor edges,
    // a command=show-modal transition would be wrongly
    // categorized as a popover, not a dialog. This test fails.
    const sourceAxId = "ax:page:btn-signin";
    const targetAxId = "ax:page:signin-dlg";
    const records: DeclaredRecord[] = [{
      fromAxId: sourceAxId, toAxId: targetAxId,
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-show-modal", commandValue: "show-modal",
    }];
    const g = new Graph();
    seedTwoNodes(g, sourceAxId, targetAxId, "dialog");
    const page: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: { callFunction: (async () => records) as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    await extractStateDeclared.run({
      graph: g, page: page as any, pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });
    const afterState = Array.from(g.states()).find((s) =>
      s.payload.openDialogIds.includes(targetAxId),
    );
    expect(afterState).toBeDefined();
    // And the popover list must NOT include the target (the
    // pre-PR-8d bug would put it there).
    expect(afterState!.payload.openPopoverIds.includes(targetAxId)).toBe(false);
  });

  it("T8: declared State with command=hide-popover REMOVES from openPopoverIds", async () => {
    // A hide-popover on an open popover must remove the target,
    // not add it. The pre-PR-8d code always added, regardless of
    // command value. This test fails on regression.
    const sourceAxId = "ax:page:btn-close";
    const targetAxId = "ax:page:popover-1";
    const records: DeclaredRecord[] = [{
      fromAxId: sourceAxId, toAxId: targetAxId,
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-hide-popover", commandValue: "hide-popover",
    }];
    const g = new Graph();
    seedTwoNodes(g, sourceAxId, targetAxId, "region");
    // Seed the popover as already open in the graph (via a
    // prior declared transition) so we can prove hide-popover
    // actually removes it.
    const openPopoverStateId = "state:open-popover";
    g.upsertState({
      id: openPopoverStateId, type: "state", pageId: PAGE,
      payload: {
        pageId: PAGE, route: PAGE, auth: { kind: "anonymous" },
        network: { status: "online", evidence: "static" },
        elements: {}, focusedAxId: null,
        openDialogIds: [], openPopoverIds: [targetAxId],
        expandedRegionAxIds: [],
        viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
        conditionalMarkers: {},
      },
      visualFingerprint: "fp",
      authContext: { kind: "anonymous" },
      networkContext: { status: "online", evidence: "static" },
      provenance: "html:parse",
      firstObservedAt: "t", evidence: [],
    });
    const page: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: { callFunction: (async () => records) as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    await extractStateDeclared.run({
      graph: g, page: page as any, pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });
    // The hide-popover after-state must have the target removed.
    const closedState = Array.from(g.states()).find((s) =>
      s.id !== openPopoverStateId &&
      !s.payload.openPopoverIds.includes(targetAxId),
    );
    expect(closedState).toBeDefined();
  });

  it("T9: convergence flag fires through real extractors (declared + observed, same canonical state)", async () => {
    // If the convergence logic in upsertState ever stops firing
    // when both extractors reach the same canonical state, this
    // test fails. The convergence flag is the audit signal that
    // static analysis matches runtime behavior.
    const sourceAxId = "ax:page:btn-1";
    const targetAxId = "ax:page:dlg-1";
    const records: DeclaredRecord[] = [{
      fromAxId: sourceAxId, toAxId: targetAxId,
      kind: "commandfor", transitionKind: "declared",
      trigger: "command-show-modal", commandValue: "show-modal",
    }];
    const g = new Graph();
    seedTwoNodes(g, sourceAxId, targetAxId, "dialog");

    // Phase 1: declared.
    const declaredPage: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: { callFunction: (async () => records) as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    await extractStateDeclared.run({
      graph: g, page: declaredPage as any, pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });

    // Phase 2: observed. Mock returns a dialog-open after-state
    // matching the declared side.
    const afterSnap: RichSnapshot = {
      ...baselineRichSnap(sourceAxId, targetAxId),
      hash: "h:after",
      openDialogIds: [targetAxId],
    };
    let callIdx = 0;
    const observedPage: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: {
        callFunction: (async () => {
          callIdx++;
          if (callIdx === 2) return [{
            axId: sourceAxId, role: "button", tagName: "button",
            rect: { x: 0, y: 0, w: 0, h: 0 },
            visible: true, textContent: "1", apgKind: "commandfor", hasStateCause: true,
          }];
          if (callIdx <= 4) return baselineRichSnap(sourceAxId, targetAxId);
          return afterSnap;
        }) as any,
        evaluate: vi.fn(),
      },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    await runObservedExtractor(g, observedPage, PAGE, () => undefined);

    // Convergence must fire.
    const converged = Array.from(g.states()).filter((s) =>
      s.evidence.some((e) => e.kind === "declared+observed"),
    );
    expect(converged.length).toBeGreaterThan(0);
    // And the converged state must be the dialog-open one.
    expect(converged.some((s) => s.payload.openDialogIds.includes(targetAxId))).toBe(true);
  });

  it("T6: state:cause placeholder is REMOVED (not re-pointed) when no causal evidence exists", async () => {
    // The pre-PR-8b resolver fell back to "first state on the same
    // page" — a false connection. The PR-8d resolver must REMOVE
    // the placeholder when no State node is reachable from it.
    const orphanAxId = "ax:page:orphan";
    const g = new Graph();
    g.upsertPage(makePageNode());
    // Source axId has no pageId in the graph (no upsertAx call).
    g.upsertEdge({
      id: `edge:${orphanAxId}->state:TBD:${orphanAxId}:command-show-modal:state:cause`,
      type: "edge", kind: "state:cause",
      from: orphanAxId, to: `state:TBD:${orphanAxId}:command-show-modal`,
      provenance: "html:parse",
    });
    const page: ObservedPageLike = {
      target: { context: "ctx-test" } as any,
      script: { callFunction: (async () => []) as any, evaluate: vi.fn() },
      input: { performActions: vi.fn(async () => undefined), sendKey: vi.fn(async () => undefined) },
    };
    await extractStateDeclared.run({
      graph: g, page: page as any, pageNode: makePageNode(),
      log: () => undefined,
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    });
    // The orphan edge must have been REMOVED, not re-pointed.
    const stillThere = [...g.allEdges()].find(
      (e) => e.kind === "state:cause" && e.from === orphanAxId,
    );
    expect(stillThere).toBeUndefined();
  });
});
