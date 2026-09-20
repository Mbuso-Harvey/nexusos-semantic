/**
 * PR-8f — Mandatory E2E validation for Layer 4.
 *
 * Per PR-8e Blocker 5 (carried forward as PR-8f merge-gate item 1): mandatory
 * E2E tests must FAIL not silently return when they cannot run. Synthetic AND
 * external are both mandatory for Layer 4 acceptance.
 *
 * Per PR-8f merge-gate item 1 (new in PR-8f): the e2e BiDi adapter must
 * preserve the production `InputApi.performActions(context, actions)`
 * signature. The previous `makePageLike` wrapper had signature
 * `performActions(actions)` and dropped the real `actions` argument
 * (sending the context string AS the actions array to the BiDi
 * transport, so no real DOM interaction ever happened — `probes=30
 * hits=0`).
 *
 * The fix: use the production `Page` object directly. `Page` already
 * exposes `target`, `script`, `input` — the exact `ObservedPageLike`
 * surface. No adapter, no `as any` to hide a signature mismatch.
 *
 * This file has TWO mandatory test blocks. They DO NOT skip.
 *
 *  1. `synthetic demo crawl` — always runs. It crawls the local
 *     demo/saas app and asserts:
 *       - probes > 0 (probe loop executed)
 *       - hits > 0 (real BiDi interactions produced DOM diffs)
 *       - State graph is non-empty
 *       - At least one `state:successor` edge exists
 *       - Every `state:TBD:*` placeholder edge was resolved
 *       - No `awg:condition-change` mechanism is involved
 *       - Declared + observed convergence fires on at least one State
 *
 *  2. `real external app` — env-gated by `AWG_E2E_URL`. When the
 *     env var is unset, this test HARD-FAILS with a clear error
 *     message rather than silently skipping. The test asserts the
 *     same end-to-end substrate invariants on a live, unmodified
 *     app.
 *
 * Constitutional gate 6: this file is the PR-8f layer-4 E2E gate.
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

async function requireBiDiPage(): Promise<{ session: BiDiSession; page: Page }> {
  if (!(await portOpen(4444))) {
    throw new Error(
      "PR-8f gate: geckodriver is not on 127.0.0.1:4444. " +
        "Start geckodriver with --allow-origins=http://127.0.0.1:9222 " +
        "and try again. The synthetic E2E gate is mandatory; " +
        "it must EXECUTE, not skip.",
    );
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const session = await BiDiSession.create();
      const { context } = await session.transport.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab" },
      );
      const page = new Page(session, context);
      return { session, page };
    } catch (err: any) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function navigateAndSettle(page: Page, url: string, ms: number): Promise<void> {
  await page.navigate(url);
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * PR-8f merge-gate item 1: regression test for the production
 * `InputApi.performActions` signature.
 *
 * The production contract is `performActions(context: string,
 * actions: Source[])`. The previous `makePageLike` wrapper in this
 * file had signature `performActions(actions: Source[])` and
 * silently dropped the context, causing every probe to send the
 * context string AS the actions array to the BiDi transport
 * (so no real DOM interaction ever happened — `probes=30 hits=0`).
 *
 * The test below pins the production signature. The compile-time
 * shape check rejects any future wrapper that drops the (context,
 * actions) shape. The runtime check against a real `Page` confirms
 * the BiDi call carries the actual `Source[]` (not the context
 * string).
 */
describe.sequential("PR-8f: production InputApi.performActions signature is preserved end-to-end", () => {
  it("InputApi.performActions forwards the context and the real Source[] unchanged", () => {
    // Compile-time shape check: a one-arg adapter cannot satisfy
    // `ObservedPageLike` without `as any` (which is the very thing
    // the binding instruction forbids). The line below assigns the
    // real `Page` shape to `ObservedPageLike` without any `as any`
    // escape — if `Page.input.performActions` ever drops the
    // (context, actions) signature, the assignment fails to
    // typecheck and the gate is red.
    type PageInput = Page["input"];
    type PerformActions = PageInput["performActions"];
    // The signature must be (context: string, actions: Source[]).
    // `Parameters<PerformActions>` exposes the tuple; the test
    // asserts its length is exactly 2 and the first element is a
    // string-shaped parameter.
    const _arity: Parameters<PerformActions> = ["ctx", []];
    void _arity;
    // A one-arg adapter with a different shape is rejected by the
    // structural type system unless it `as any` the cast. The
    // declaration below intentionally omits `as any` so any future
    // regression that re-introduces a one-arg wrapper fails the
    // typecheck immediately.
    type RealPageAdapter = Pick<Page, "target" | "script" | "input">;
    const realAdapter: RealPageAdapter = null as unknown as RealPageAdapter;
    // The line below is the gate. No `as any`. A future
    // `makePageLike`-style wrapper with a different shape will
    // fail this assignment at compile time.
    const _admissibility: ObservedPageLike = realAdapter;
    void _admissibility;
    expect(true).toBe(true);
  });

  it("Page.input.performActions carries the Source[] payload to the BiDi transport", async () => {
    // Runtime check: the real `Page.input.performActions(context,
    // actions)` must invoke the BiDi `input.performActions` command
    // with the unchanged (context, actions) payload. We exercise it
    // against a geckodriver-backed session and assert the wire
    // shape via the Page's transport.
    if (!(await portOpen(4444))) {
      throw new Error("PR-8f gate: geckodriver not on 127.0.0.1:4444");
    }
    let session: BiDiSession | undefined;
    let page: Page | undefined;
    try {
      session = await BiDiSession.create();
      const { context } = await session.transport.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab" },
      );
      page = new Page(session, context);
      // Capture the wire payload by wrapping transport.send. This is
      // the only way to assert "the actions array survived the
      // adapter" without running the full probe loop.
      const sent: Array<{ method: string; params: any }> = [];
      const origSend = session.transport.send.bind(session.transport);
      (session.transport as any).send = async (method: string, params: any) => {
        sent.push({ method, params });
        return origSend(method, params);
      };
      const realActions = [
        {
          type: "pointer" as const, id: "probe-mouse", parameters: { pointerType: "mouse" as const },
          actions: [
            { type: "pointerMove" as const, x: 10, y: 20 },
            { type: "pointerDown" as const, button: 0 as const },
            { type: "pointerUp" as const, button: 0 as const },
          ],
        },
      ];
      await page.input.performActions(context, realActions);
      // The wire call must carry `context` and the same `actions` array.
      const bidiCall = sent.find((s) => s.method === "input.performActions");
      expect(bidiCall, "PR-8f: a BiDi input.performActions call must be sent").toBeTruthy();
      expect(bidiCall!.params.context).toBe(context);
      expect(JSON.stringify(bidiCall!.params.actions)).toBe(JSON.stringify(realActions));
    } finally {
      if (page) try { await page.close(); } catch { /* swallow */ }
      if (session) try { await session.close(); } catch { /* swallow */ }
    }
  }, 60_000);
});

describe.sequential("PR-8f — Layer 4 constitutional E2E (mandatory; must fail, not skip)", () => {
  describe.sequential("synthetic demo/saas (always executes)", () => {
    const target = process.env.AWG_DEMO_URL ?? "http://127.0.0.1:7311/";
    let session: BiDiSession | undefined;
    let page: Page | undefined;

    beforeAll(async () => {
      const r = await requireBiDiPage();
      session = r.session;
      page = r.page;
    }, 60_000);

    afterAll(async () => {
      if (!session || !page) return;
      try { await page.close(); } catch { /* swallow */ }
      try { await session.close(); } catch { /* swallow */ }
    });

    it("crawls demo/saas, produces real probe hits and a state:successor edge", async () => {
      await navigateAndSettle(page!, target, 1500);
      const pageId = `page:${target}`;
      const graph = new Graph();
      // PR-8f T1: pass the real `Page` directly. No adapter, no
      // `as any`. The Page exposes the exact `ObservedPageLike`
      // surface (`target`, `script`, `input`).
      const pageLike: ObservedPageLike = page!;
      const logs: string[] = [];
      const result = await runObservedExtractor(graph, pageLike, pageId, (msg) => { logs.push(msg); });
      // eslint-disable-next-line no-console
      console.error("PR-8f E2E diagnostic:\n" + logs.join("\n"));

      // PR-8f gate: real probes must have executed.
      expect(result.result.probes, "PR-8f: synthetic probe loop must run >0 probes").toBeGreaterThan(0);
      // PR-8f gate: at least one real BiDi interaction must have
      // produced a real DOM diff.
      expect(result.result.hits.length, "PR-8f: synthetic run must produce real BiDi hits (>0)").toBeGreaterThan(0);
      // The state:successor edge count is the canonical "the
      // substrate produced a real transition" assertion.
      const successors = [...graph.allEdges()].filter((e) => e.kind === "state:successor");
      expect(
        successors.length,
        "PR-8f: synthetic run must produce at least one state:successor edge",
      ).toBeGreaterThan(0);
      // The state graph must have more than the single baseline.
      expect(graph.stateCount, "PR-8f: synthetic State graph must have more than the baseline").toBeGreaterThan(1);
      // No placeholders survived materialization.
      for (const e of graph.allEdges()) {
        expect(e.to.startsWith("state:TBD:"), "PR-8f: state:TBD:* must be fully resolved").toBe(false);
      }
    }, 60_000);

    it("declared + observed convergence fires on at least one State (Blocker 3+6)", async () => {
      await navigateAndSettle(page!, target, 1500);
      const pageId = `page:${target}`;
      const graph = new Graph();
      // Seed a page node so the structural extractor can attach
      // AxNodes to it.
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
        pageNode: {
          id: pageId, url: target, title: target,
          type: "page", discoveredVia: ["seed"], loadStatus: "complete",
          axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
          viewport: { w: 1280, h: 800, dpr: 1 },
          tokensOverride: null, screenshotRef: null,
          canonicalUrl: target, crawledAt: new Date().toISOString(), parentPageId: null,
        } as any,
        log: () => undefined,
        auth: { kind: "anonymous" } as AuthContext,
        network: { status: "online", evidence: "static" } as NetworkContext,
        budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
      };
      // The orchestrator normally runs the structural extractor
      // first to populate AxNodes; we replicate that here so the
      // declared and observed paths share the same element set.
      await structuralExtractor.run(ctx);
      await extractStateDeclared.run(ctx);
      const result = await runObservedExtractor(graph, pageLike, pageId, () => undefined);
      void result;
      // The declared+observed convergence requires the declared
      // path and the observed path to materialize the same State.
      // The state-evidence union in `graph.upsertState` promotes
      // the evidence kind to "declared+observed" when both are
      // present. Assert that at least one such state was produced.
      const converged = Array.from(graph.states()).filter((s) =>
        s.evidence.some((e) => e.kind === "declared+observed"),
      );
      expect(
        converged.length,
        "PR-8f: declared+observed convergence must fire on the synthetic demo where a declared primitive exists",
      ).toBeGreaterThan(0);
    }, 60_000);

    it("no awg:condition-change mechanism participates (Blocker 1+4)", async () => {
      await navigateAndSettle(page!, target, 1500);
      const pageId = `page:${target}`;
      const graph = new Graph();
      const pageLike: ObservedPageLike = page!;
      await runObservedExtractor(graph, pageLike, pageId, () => {});

      for (const e of graph.allEdges()) {
        const asJson = JSON.stringify(e);
        expect(
          asJson.includes("awg:condition-change"),
          "PR-8f: no edge may reference awg:condition-change",
        ).toBe(false);
      }
      for (const s of graph.states()) {
        const asJson = JSON.stringify(s);
        expect(
          asJson.includes("awg:condition-change"),
          "PR-8f: no State may reference awg:condition-change",
        ).toBe(false);
      }
    }, 60_000);
  });

  describe.sequential("external unmodified app (mandatory; AWG_E2E_URL must be set)", () => {
    // PR-8f merge-gate item 6: the external E2E gate is mandatory
    // for Layer 4 acceptance. The legacy "PR-8 T14" test silently
    // skipped when the env var was unset, which is forbidden. This
    // test FAILS HARD when AWG_E2E_URL is not set.
    const url = process.env.AWG_E2E_URL;
    let session: BiDiSession | undefined;
    let page: Page | undefined;

    beforeAll(async () => {
      if (!url) {
        throw new Error(
          "PR-8f gate: AWG_E2E_URL is not set. The external E2E gate is " +
            "mandatory for Layer 4 acceptance. Set AWG_E2E_URL to a live, " +
            "unmodified web app with declared state primitives (popover, " +
            "dialog, tablist, menu, combobox) and a navigable multi-page " +
            "hierarchy. See docs/STATUS.md for the candidate list.",
        );
      }
      const r = await requireBiDiPage();
      session = r.session;
      page = r.page;
    }, 60_000);

    afterAll(async () => {
      if (!session || !page) return;
      try { await page.close(); } catch { /* swallow */ }
      try { await session.close(); } catch { /* swallow */ }
    });

    it("produces real hits and a state:successor edge on a live, unmodified site with declared state primitives", async () => {
      // The beforeAll() throws when AWG_E2E_URL is unset, so the
      // test never reaches here without the env var.
      await navigateAndSettle(page!, url!, 1500);
      const pageId = `page:${url}`;
      const graph = new Graph();
      const pageLike: ObservedPageLike = page!;
      const result = await runObservedExtractor(graph, pageLike, pageId, () => {});

      // PR-8f gate: real probes, real hits, real successor.
      expect(result.result.probes, "PR-8f: external probe loop must run >0 probes").toBeGreaterThan(0);
      expect(result.result.hits.length, "PR-8f: external run must produce real BiDi hits (>0)").toBeGreaterThan(0);
      expect(graph.stateCount, "PR-8f: external State graph must be non-empty").toBeGreaterThan(0);
      const successors = [...graph.allEdges()].filter((e) => e.kind === "state:successor");
      expect(
        successors.length,
        "PR-8f: external run must produce at least one state:successor edge",
      ).toBeGreaterThan(0);
      for (const e of graph.allEdges()) {
        expect(e.to.startsWith("state:TBD:")).toBe(false);
      }
    }, 60_000);

    /**
     * PR-8g T4 / PR-8h (blocker 4): the external E2E gate must
     * exercise the FULL Layer 4 pipeline: `structuralExtractor ->
     * extractStateDeclared -> runObservedExtractor`. The legacy
     * external gate only ran the observed half; that is not
     * Layer 4. The full pipeline surfaces declared state
     * primitives (popover, dialog, tablist, menu, combobox) that
     * the observed probe loop alone cannot discover.
     *
     * PR-8h T5 correction: the original PR-8g T4 test asserted
     * `declared+observed` convergence on the external site. That
     * assertion was an overclaim: convergence requires (a) the
     * site to expose the static-ARIA primitives the declared
     * extractor maps to a `state:cause` transition (e.g. a
     * `<button popovertarget>`, a `<button command>`, a
     * `<div role="tablist">`), AND (b) the observed probe loop
     * to fire on an element that resolves to the same AxNode. No
     * real unmodified public site surveyed (duckduckgo.com,
     * github.com, w3.org/WAI/ARIA/apg/*, react-spectrum.adobe.com,
     * notion.so, web.dev, developer.mozilla.org) carries the
     * right combination in static HTML — modern web apps are
     * JS-rendered SPAs whose declared ARIA is not present at
     * initial paint. The authoritative convergence test is the
     * synthetic one above (which runs against the local demo at
     * `AWG_DEMO_URL` and has the right static ARIA). The
     * external test now asserts the FULL pipeline runs end-to-end
     * on a real unmodified site and surfaces whatever declared
     * primitives the site happens to have.
     */
    it("exercises the full Layer 4 pipeline (structural + declared + observed) on a real unmodified site", async () => {
      await navigateAndSettle(page!, url!, 1500);
      const pageId = `page:${url}`;
      const graph = new Graph();
      // Seed the page node so the structural extractor can attach
      // AxNodes to it. Same shape as the synthetic test uses.
      graph.upsertPage({
        id: pageId, type: "page", url: url!, title: url!,
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
        viewport: { w: 1280, h: 800, dpr: 1 },
        tokensOverride: null, screenshotRef: null,
        canonicalUrl: url!, crawledAt: new Date().toISOString(), parentPageId: null,
      });
      const pageLike: ObservedPageLike = page!;
      const ctx: ExtractorContext = {
        graph,
        page: pageLike as any,
        pageNode: {
          id: pageId, url: url!, title: url!,
          type: "page", discoveredVia: ["seed"], loadStatus: "complete",
          axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
          viewport: { w: 1280, h: 800, dpr: 1 },
          tokensOverride: null, screenshotRef: null,
          canonicalUrl: url!, crawledAt: new Date().toISOString(), parentPageId: null,
        } as any,
        log: () => undefined,
        auth: { kind: "anonymous" } as AuthContext,
        network: { status: "online", evidence: "static" } as NetworkContext,
        budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
      };
      // Full Layer 4 pipeline. Order matters: structural first
      // (so AxNodes are in the graph for the declared path to
      // reference), then declared (so StateNodes + state:cause
      // edges are emitted before the observed path tries to
      // resolve them), then observed (so the observed probe loop
      // runs over the same element set).
      await structuralExtractor.run(ctx);
      await extractStateDeclared.run(ctx);
      const result = await runObservedExtractor(graph, pageLike, pageId, () => undefined);
      // Sanity: the observed probe loop must have run.
      expect(result.result.probes, "PR-8h T5: external full-pipeline observed probes > 0").toBeGreaterThan(0);
      // The structural extractor must have produced AxNodes.
      expect(graph.axCount, "PR-8h T5: external structural extractor must populate AxNodes").toBeGreaterThan(0);
      // The full pipeline must have produced a non-empty state
      // graph. (For a real unmodified site without the right
      // static ARIA, the declared extractor may emit zero states
      // and the observed extractor emits the observed-only
      // states; both are valid outcomes of the full pipeline.)
      expect(
        graph.stateCount,
        "PR-8h T5: external full-pipeline state graph non-empty (observed half always emits; declared half emits when the site has the right static ARIA)",
      ).toBeGreaterThan(0);
      // PR-8j T3: external convergence is MANDATORY. The previous
      // "if set, assert; else log" pattern was the success-when-
      // absent defect the user audit identified. The binding gate
      // is: the operator MUST supply a target that carries the
      // right static ARIA, and the full pipeline MUST surface at
      // least one `declared+observed` State. Missing
      // `AWG_CONVERGENCE_URL` HARD-FAILS.
      //
      // (a) AWG_CONVERGENCE_URL unset → throw. CI must supply a
      //     concrete URL (the workflow sets it to the W3C ARIA
      //     APG combobox-select-only example, which carries a
      //     static ARIA combobox AND a real BiDi probe that
      //     changes the value — both halves of
      //     `hasDeclared && hasObserved`).
      // (b) AWG_CONVERGENCE_URL set → assert
      //     `converged.length > 0` against that URL.
      const convergenceUrl = process.env.AWG_CONVERGENCE_URL;
      if (!convergenceUrl) {
        throw new Error(
          "PR-8j T3: AWG_CONVERGENCE_URL is not set. The external " +
          "convergence gate is mandatory for Layer 4 acceptance. " +
          "Set AWG_CONVERGENCE_URL to a live, unmodified web app " +
          "with static ARIA (popover / dialog / tablist / menu / " +
          "combobox) AND a real BiDi probe that changes a state " +
          "on the same element. The W3C ARIA APG combobox-select-" +
          "only example is the canonical target. " +
          "See docs/EXECUTIVE_DECISIONS.md ED-01 addendum PR-8j.",
        );
      }
      const converged = Array.from(graph.states()).filter((s) =>
        s.evidence.some((e) => e.kind === "declared+observed"),
      );
      // The convergence URL is a *different* target than the
      // external URL. Re-crawl it and assert convergence.
      await navigateAndSettle(page!, convergenceUrl, 1500);
      const convergencePageId = `page:${convergenceUrl}`;
      const convergenceGraph = new Graph();
      convergenceGraph.upsertPage({
        id: convergencePageId, type: "page", url: convergenceUrl, title: convergenceUrl,
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: `ax:${convergencePageId}:root`, provenance: "bidi:script.evaluate" },
        viewport: { w: 1280, h: 800, dpr: 1 },
        tokensOverride: null, screenshotRef: null,
        canonicalUrl: convergenceUrl, crawledAt: new Date().toISOString(), parentPageId: null,
      });
      const convergencePageLike: ObservedPageLike = page!;
      const convergenceCtx: ExtractorContext = {
        graph: convergenceGraph,
        page: convergencePageLike as any,
        pageNode: {
          id: convergencePageId, url: convergenceUrl, title: convergenceUrl,
          type: "page", discoveredVia: ["seed"], loadStatus: "complete",
          axTreeRef: { rootAxId: `ax:${convergencePageId}:root`, provenance: "bidi:script.evaluate" },
          viewport: { w: 1280, h: 800, dpr: 1 },
          tokensOverride: null, screenshotRef: null,
          canonicalUrl: convergenceUrl, crawledAt: new Date().toISOString(), parentPageId: null,
        } as any,
        log: () => undefined,
        auth: { kind: "anonymous" } as AuthContext,
        network: { status: "online", evidence: "static" } as NetworkContext,
        budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
      };
      await structuralExtractor.run(convergenceCtx);
      await extractStateDeclared.run(convergenceCtx);
      await runObservedExtractor(convergenceGraph, convergencePageLike, convergencePageId, () => {});
      const convergenceConverged = Array.from(convergenceGraph.states()).filter((s) =>
        s.evidence.some((e) => e.kind === "declared+observed"),
      );
      expect(
        convergenceConverged.length,
        `PR-8j T3: declared+observed convergence MUST fire on AWG_CONVERGENCE_URL=${convergenceUrl}. ` +
        `If the URL has been moved, pick a different static-ARIA target. ` +
        `See docs/EXECUTIVE_DECISIONS.md ED-01 addendum PR-8j for the candidate list.`,
      ).toBeGreaterThan(0);
      void converged;
      // No state:TBD placeholders survived materialization.
      for (const e of graph.allEdges()) {
        expect(e.to.startsWith("state:TBD:"), "PR-8h T5: state:TBD:* must be fully resolved").toBe(false);
      }
    }, 90_000);

    /**
     * PR-8g T4 (blocker 4): the external E2E must assert that
     * the State graph contains `state:successor` edges with
     * real, semantic trigger values — NOT a degenerate all-`null`
     * graph. This pins the trigger-truthfulness contract end-to-
     * end: every `state:successor` edge in the State graph must
     * carry a `triggers` array whose union is non-empty and
     * includes at least one of the canonical trigger kinds.
     */
    it("emits state:successor edges with truthful trigger values (Blocker 1+2 trigger truthfulness)", async () => {
      await navigateAndSettle(page!, url!, 1500);
      const pageId = `page:${url}`;
      const graph = new Graph();
      const pageLike: ObservedPageLike = page!;
      await runObservedExtractor(graph, pageLike, pageId, () => {});

      const successors = [...graph.allEdges()].filter((e) => e.kind === "state:successor");
      expect(
        successors.length,
        "PR-8g T4: external run must produce at least one state:successor edge",
      ).toBeGreaterThan(0);
      // Every successor edge must carry a non-empty triggers array
      // with at least one canonical trigger kind. This is the
      // trigger-truthfulness assertion: an edge without triggers
      // is not a real transition.
      for (const e of successors) {
        expect(
          Array.isArray(e.triggers) && e.triggers.length > 0,
          "PR-8g T4: every state:successor edge must have at least one trigger",
        ).toBe(true);
        // The trigger set must be a subset of the canonical
        // `TransitionTrigger` union (no fabricated triggers).
        const VALID: ReadonlySet<string> = new Set([
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
        for (const t of e.triggers!) {
          expect(
            VALID.has(t),
            `PR-8g T4: trigger '${t}' on edge ${e.id} is not in the canonical TransitionTrigger union`,
          ).toBe(true);
        }
      }
    }, 60_000);
  });
});
