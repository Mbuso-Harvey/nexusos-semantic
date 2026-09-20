/**
 * PR-8f — Convergence trace diagnostic.
 *
 * Traces the convergence on the synthetic demo: run structural,
 * declared, and observed extractors; log every State and its
 * evidence kind. The test is a diagnostic — it passes by default
 * (so the E2E is not blocked) but emits structured diagnostic
 * output that PR-8f reviewers can use to verify the
 * declared+observed convergence mechanism works.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createConnection } from "node:net";
import { BiDiSession, Page } from "../../src/bidi-client/index.js";
import { Graph } from "../../src/graph/graph.js";
import { runObservedExtractor } from "../../src/extract-state/observed.js";
import type { ObservedPageLike } from "../../src/extract-state/observed.js";
import { extractStateDeclared } from "../../src/extract-state/declared.js";
import { structuralExtractor } from "../../src/extract-structure/structural.js";
import type { ExtractorContext } from "../../src/crawler/orchestrator.js";
import type { AuthContext, NetworkContext } from "../../src/graph/types.js";

async function portOpen(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return await new Promise((res) => {
    const s = createConnection({ port, host }, () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
}

describe("PR-8f: convergence trace on synthetic demo", () => {
  const target = process.env.AWG_DEMO_URL ?? "http://127.0.0.1:7311/";
  let session: BiDiSession | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    if (!(await portOpen(4444))) {
      throw new Error("PR-8f trace: geckodriver not on 127.0.0.1:4444");
    }
    const s = await BiDiSession.create();
    const { context } = await s.transport.send<{ context: string }>(
      "browsingContext.create", { type: "tab" },
    );
    session = s;
    page = new Page(s, context);
    await page.navigate(target);
    await new Promise((r) => setTimeout(r, 1500));
  }, 30_000);

  afterAll(async () => {
    if (!session || !page) return;
    try { await page.close(); } catch { /* swallow */ }
    try { await session.close(); } catch { /* swallow */ }
  });

  it("logs every state id, evidence kind, and the per-state element set", async () => {
    const pageId = `page:${target}`;
    const graph = new Graph();
    graph.upsertPage({
      id: pageId, type: "page", url: target, title: target,
      discoveredVia: ["seed"], loadStatus: "complete",
      axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null, screenshotRef: null,
      canonicalUrl: target, crawledAt: new Date().toISOString(), parentPageId: null,
    });
    const pageLike: ObservedPageLike = page!;
    const ctx: ExtractorContext = {
      graph,
      page: pageLike as any,
      pageNode: { id: pageId, url: target, viewport: { w: 1280, h: 595, dpr: 1.5 } } as any,
      log: (m) => { /* trace log */ },
      auth: { kind: "anonymous" } as AuthContext,
      network: { status: "online", evidence: "static" } as NetworkContext,
      budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
    };
    await structuralExtractor.run(ctx);
    // PR-8f: log the AxNode set the structural walker produced
    // (this is the union the declared materializer will use).
    const axByPage = [...graph.axNodes()].filter((a) => a.pageId === pageId);
    // eslint-disable-next-line no-console
    console.error(`[trace] axNode count for pageId=${pageId}: ${axByPage.length}`);
    // Sample 3 elements by role family to inspect the state fields.
    const sample = axByPage.find((a) => a.role === "tab")
      ?? axByPage.find((a) => a.role === "button")
      ?? axByPage[0];
    if (sample) {
      // eslint-disable-next-line no-console
      console.error(`[trace] sample axNode: id=${sample.id} role=${sample.role} visibility=${sample.visibility} states=${JSON.stringify(sample.states)}`);
    }
    // Snapshot the declared baseline element set BEFORE the declared
    // extractor runs so we can compare it to the observed materializer's
    // augmentation after the observed extractor runs.
    const declaredBaselineElementKeys = new Set(axByPage.map((a) => a.id));
    // Take a rich snapshot directly so we can compare it to the
    // declared baseline element map.
    const { takeRichSnapshot } = await import("../../src/extract-state/observed.js");
    const preBaseline = await takeRichSnapshot(pageLike, pageId);
    // eslint-disable-next-line no-console
    console.error(`[trace] rich snapshot element count: ${preBaseline.elements.length}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] rich snapshot openDialogIds: ${JSON.stringify(preBaseline.openDialogIds)}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] rich snapshot openPopoverIds: ${JSON.stringify(preBaseline.openPopoverIds)}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] rich snapshot expandedRegionAxIds: ${JSON.stringify(preBaseline.expandedRegionAxIds)}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] rich snapshot hash: ${preBaseline.hash}`);
    // Find elements in the rich snapshot with non-null state values.
    const richStateful = preBaseline.elements.filter((e) =>
      e.selected !== null || e.expanded !== null || e.checked !== null
      || e.pressed !== null || e.open !== null || e.busy !== null
    );
    // eslint-disable-next-line no-console
    console.error(`[trace] rich snapshot stateful elements: ${richStateful.length}`);
    for (const e of richStateful.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.error(`[trace]   ${e.axId} selected=${e.selected} expanded=${e.expanded} checked=${e.checked} pressed=${e.pressed} open=${e.open} busy=${e.busy}`);
    }
    // Find AxNodes that the structural walker thinks have state.
    const axStateful = axByPage.filter((a) =>
      a.states.selected !== null || a.states.expanded !== null
      || a.states.checked !== null || a.states.pressed !== null
      || a.states.busy !== null || a.states.open !== null
    );
    // eslint-disable-next-line no-console
    console.error(`[trace] axNode stateful elements: ${axStateful.length}`);
    for (const a of axStateful.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.error(`[trace]   ${a.id} selected=${a.states.selected} expanded=${a.states.expanded} checked=${a.states.checked} pressed=${a.states.pressed} busy=${a.states.busy} open=${a.states.open}`);
    }
    // Dump the full rich-snapshot element axId set vs the axNode set.
    const richAxIds = new Set(preBaseline.elements.map((e) => e.axId));
    const inRichNotInAx = [...richAxIds].filter((id) => !declaredBaselineElementKeys.has(id));
    const inAxNotInRich = [...declaredBaselineElementKeys].filter((id) => !richAxIds.has(id));
    // eslint-disable-next-line no-console
    console.error(`[trace] in-rich-not-in-ax: ${inRichNotInAx.length} ${JSON.stringify(inRichNotInAx.slice(0, 5))}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] in-ax-not-in-rich: ${inAxNotInRich.length} ${JSON.stringify(inAxNotInRich.slice(0, 5))}`);
    // PR-8f: compare the rich-snapshot element observations against
    // the declared AxNode observations for the same axIds. The two
    // paths must agree on the semantic projection; any divergence is
    // a state-id collision bug.
    const axById = new Map(axByPage.map((a) => [a.id, a]));
    const diffs: string[] = [];
    for (const re of preBaseline.elements) {
      const ax = axById.get(re.axId);
      if (!ax) continue;
      const richSem = { visibility: re.visibility, open: re.open, expanded: re.expanded, selected: re.selected, checked: re.checked, pressed: re.pressed, busy: re.busy };
      const axSem = { visibility: ax.visibility, open: ax.states.open, expanded: ax.states.expanded, selected: ax.states.selected, checked: ax.states.checked, pressed: ax.states.pressed, busy: ax.states.busy };
      const rh = JSON.stringify(richSem);
      const ah = JSON.stringify(axSem);
      if (rh !== ah) diffs.push(`${re.axId} rich=${rh} ax=${ah}`);
    }
    // eslint-disable-next-line no-console
    console.error(`[trace] semantic diffs between rich and axNode: ${diffs.length}`);
    for (const d of diffs.slice(0, 5)) {
      // eslint-disable-next-line no-console
      console.error(`[trace]   ${d}`);
    }
    // PR-8f: directly hash the canonical payloads of the declared
    // baseline vs the observed baseline to find the remaining
    // divergence. The declared baseline is built from `axNodeToObservation`
    // (visibility from `ax.visibility`, open from `ax.states.open`,
    // states from `ax.states.*`). The observed baseline is built by
    // `richToMaterializeSnapshot` (rich snapshot + augmentation with
    // `ax.states.*`).
    const { deriveStateId, buildStatePayload } = await import("../../src/graph/state-id.js");
    const { AuthContext, NetworkContext } = await import("../../src/graph/types.js") as any;
    const authCtx: AuthContext = { kind: "anonymous" };
    const netCtx: NetworkContext = { status: "online", evidence: "static" };
    const declaredPayload = buildStatePayload({
      pageId,
      route: target,
      auth: authCtx,
      network: netCtx,
      elements: Object.fromEntries(axByPage.map((ax) => [ax.id, {
        axId: ax.id,
        rect: { x: 0, y: 0, w: 0, h: 0 },
        visibility: ax.visibility,
        zIndex: null,
        open: ax.states.open,
        expanded: ax.states.expanded,
        selected: ax.states.selected,
        checked: ax.states.checked,
        pressed: ax.states.pressed,
        busy: ax.states.busy,
        // PR-8g T1: per-element focus flag (false in declared path).
        focused: false,
        ariaStates: {},
        visualNodeId: null,
      }])),
      // PR-8g T1: State-level focus pointer (null in declared path).
      focusedAxId: null,
      openDialogIds: [],
      openPopoverIds: [],
      expandedRegionAxIds: [],
      viewport: { w: preBaseline.viewport.w, h: preBaseline.viewport.h, dpr: preBaseline.viewport.dpr, scrollX: 0, scrollY: 0 },
      conditionalMarkers: {},
    });
    const declaredId = deriveStateId(declaredPayload);
    // eslint-disable-next-line no-console
    console.error(`[trace] declared-baseline id: ${declaredId}`);
    // Build the observed baseline payload (rich + augmented).
    const obsElements: Record<string, any> = {};
    for (const re of preBaseline.elements) {
      obsElements[re.axId] = {
        axId: re.axId,
        rect: { x: 0, y: 0, w: 0, h: 0 },
        visibility: re.visibility,
        zIndex: null,
        open: re.open,
        expanded: re.expanded,
        selected: re.selected,
        checked: re.checked,
        pressed: re.pressed,
        busy: re.busy,
        ariaStates: {},
        visualNodeId: null,
      };
    }
    for (const ax of axByPage) {
      if (obsElements[ax.id]) continue;
      obsElements[ax.id] = {
        axId: ax.id,
        rect: { x: 0, y: 0, w: 0, h: 0 },
        visibility: ax.visibility,
        zIndex: null,
        open: ax.states.open,
        expanded: ax.states.expanded,
        selected: ax.states.selected,
        checked: ax.states.checked,
        pressed: ax.states.pressed,
        busy: ax.states.busy,
        // PR-8g T1: per-element focus flag.
        focused: false,
        ariaStates: {},
        visualNodeId: null,
      };
    }
    const obsPayload = buildStatePayload({
      pageId,
      route: target,
      auth: authCtx,
      network: netCtx,
      elements: obsElements,
      // PR-8g T1: State-level focus pointer.
      focusedAxId: null,
      openDialogIds: preBaseline.openDialogIds,
      openPopoverIds: preBaseline.openPopoverIds,
      expandedRegionAxIds: preBaseline.expandedRegionAxIds,
      viewport: preBaseline.viewport,
      conditionalMarkers: preBaseline.conditionalMarkers,
    });
    const obsId = deriveStateId(obsPayload);
    // eslint-disable-next-line no-console
    console.error(`[trace] observed-baseline id: ${obsId}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] ids match: ${declaredId === obsId}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] declared elements: ${Object.keys(declaredPayload.elements).length} vs obs: ${Object.keys(obsPayload.elements).length}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] declared conditionalMarkers: ${JSON.stringify(declaredPayload.conditionalMarkers)}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] obs conditionalMarkers: ${JSON.stringify(obsPayload.conditionalMarkers)}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] declared viewport: ${JSON.stringify(declaredPayload.viewport)}`);
    // eslint-disable-next-line no-console
    console.error(`[trace] obs viewport: ${JSON.stringify(obsPayload.viewport)}`);
    if (declaredId !== obsId) {
      // Find the first differing key.
      const dKeys = Object.keys(declaredPayload.elements).sort();
      const oKeys = Object.keys(obsPayload.elements).sort();
      const onlyD = dKeys.filter((k) => !oKeys.includes(k));
      const onlyO = oKeys.filter((k) => !dKeys.includes(k));
      // eslint-disable-next-line no-console
      console.error(`[trace] only in declared: ${onlyD.length} sample: ${JSON.stringify(onlyD.slice(0, 3))}`);
      // eslint-disable-next-line no-console
      console.error(`[trace] only in obs: ${onlyO.length} sample: ${JSON.stringify(onlyO.slice(0, 3))}`);
      // Find the first axId where the element content differs.
      let firstDiff: string | null = null;
      for (const k of dKeys) {
        const d = (declaredPayload.elements as any)[k];
        const o = (obsPayload.elements as any)[k];
        if (!o) { firstDiff = `${k} missing in obs`; break; }
        const dStr = JSON.stringify({ visibility: d.visibility, open: d.open, expanded: d.expanded, selected: d.selected, checked: d.checked, pressed: d.pressed, busy: d.busy });
        const oStr = JSON.stringify({ visibility: o.visibility, open: o.open, expanded: o.expanded, selected: o.selected, checked: o.checked, pressed: o.pressed, busy: o.busy });
        if (dStr !== oStr) { firstDiff = `${k} d=${dStr} o=${oStr}`; break; }
      }
      // eslint-disable-next-line no-console
      console.error(`[trace] first content diff: ${firstDiff}`);
    }
    await extractStateDeclared.run(ctx);
    const declaredStateCount = graph.stateCount;
    const declaredIds = [...graph.states()].map((s) => s.id);
    const declaredKinds = [...graph.states()].map((s) =>
      s.evidence.map((e) => e.kind).join("|")
    );
    // eslint-disable-next-line no-console
    console.error("[trace] declared states:", declaredStateCount);
    for (let i = 0; i < declaredIds.length; i++) {
      // eslint-disable-next-line no-console
      console.error(`[trace]   ${i}: ${declaredIds[i]} kinds=${declaredKinds[i]}`);
    }
    // Capture the BEFORE runObservedExtractor so we can print the
    // observed materializer's element map size + a sample.
    const before = await runObservedExtractor(graph, pageLike, pageId, () => {});
    void before;
    const finalIds = [...graph.states()].map((s) => s.id);
    const finalKinds = [...graph.states()].map((s) =>
      s.evidence.map((e) => e.kind).join("|")
    );
    // eslint-disable-next-line no-console
    console.error("[trace] final states:", graph.stateCount);
    for (let i = 0; i < finalIds.length; i++) {
      // eslint-disable-next-line no-console
      console.error(`[trace]   ${i}: ${finalIds[i]} kinds=${finalKinds[i]}`);
    }
    // PR-8f: log overlap count.
    const declaredIdSet = new Set(declaredIds);
    const observedOnly = finalIds.filter((id) => !declaredIdSet.has(id));
    const converged = finalIds.filter((id) => declaredIdSet.has(id));
    // eslint-disable-next-line no-console
    console.error(`[trace] converged=${converged.length} observed-only=${observedOnly.length}`);
    // The test is informational. The convergence count is logged
    // but not asserted here; the assertions live in the E2E file.
    expect(true).toBe(true);
  }, 30_000);
});
