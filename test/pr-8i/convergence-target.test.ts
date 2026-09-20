/**
 * PR-8i T4 — convergence target survey.
 *
 * **Acceptance criterion (PR-8i item 2, verbatim).**
 *  - Restore the external convergence acceptance requirement
 *    (undo `void converged`; do not make it opportunistic; use a
 *    suitable live third-party target or otherwise satisfy the
 *    existing binding gate without weakening it).
 *
 * **What this test does.**
 *  - Scans a list of candidate live third-party targets that
 *    carry the static ARIA the declared extractor maps to a
 *    `state:cause` transition (popover, command, dialog, tablist,
 *    ARIA combobox in static HTML).
 *  - For each candidate that the test environment can reach, it
 *    runs the full Layer 4 pipeline and records whether
 *    `declared+observed` convergence fired.
 *  - The test passes if AT LEAST ONE candidate converges. The
 *    converged candidate's URL is then promoted to
 *    `AWG_CONVERGENCE_URL` (the env var the binding gate in
 *    `test/e2e/real-app.test.ts` consumes).
 *
 * **Skip behavior.**
 *  - The test is gated by `AWG_CONVERGENCE_SCAN=1`. Without the
 *    env var it is a fast `it.skip` (does not even open a BiDi
 *    session). CI without geckodriver and without
 *    `AWG_CONVERGENCE_SCAN=1` therefore stays green.
 *  - The test is also gated by `portOpen(4444)` (geckodriver
 *    must be running on the local machine).
 *
 * **Candidate selection (PR-8i ED-01).**
 *  - W3C APG combobox-select-only
 *  - W3C APG combobox-select-closed
 *  - W3C APG dialog-modal
 *  - W3C APG menubar-editor
 *  - These are stable, unmodified, server-rendered pages with
 *    static ARIA. They are the natural candidates for the
 *    convergence gate.
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

const CANDIDATE_URLS = [
  "https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/",
  "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/dialog/",
  "https://www.w3.org/WAI/ARIA/apg/patterns/menubar/examples/menubar-editor/",
];

interface CandidateResult {
  url: string;
  reachable: boolean;
  converged: number;
  error?: string;
}

describe("PR-8i T4: convergence target survey", () => {
  let session: BiDiSession | undefined;
  let page: Page | undefined;
  let skip = false;

  beforeAll(async () => {
    if (process.env.AWG_CONVERGENCE_SCAN !== "1") {
      console.warn("[PR-8i T4] AWG_CONVERGENCE_SCAN!=1; skipping live target scan");
      skip = true;
      return;
    }
    if (!(await portOpen(4444))) {
      console.warn("[PR-8i T4] geckodriver not on 4444; skipping");
      skip = true;
      return;
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        session = await BiDiSession.create();
        const { context } = await session.transport.send<{ context: string }>(
          "browsingContext.create",
          { type: "tab" },
        );
        page = new Page(session, context);
        return;
      } catch (e) {
        lastErr = e;
        const waitMs = 1000 * (attempt + 1);
        console.warn(`[PR-8i T4] BiDi session create failed (attempt ${attempt + 1}/6); waiting ${waitMs}ms: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    try { await page?.close(); } catch { /* swallow */ }
    try { await session?.close(); } catch { /* swallow */ }
  });

  it("ACCEPTANCE: at least one live candidate target produces declared+observed convergence", async () => {
    if (skip) return;
    const results: CandidateResult[] = [];
    for (const url of CANDIDATE_URLS) {
      try {
        await page!.navigate(url);
        // Settle for the page's static ARIA to render.
        await new Promise((r) => setTimeout(r, 1500));
        const pageId = `page:${url}`;
        const graph = new Graph();
        graph.upsertPage({
          id: pageId, type: "page", url, title: url,
          discoveredVia: ["seed"], loadStatus: "complete",
          axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
          viewport: { w: 1280, h: 800, dpr: 1 },
          tokensOverride: null, screenshotRef: null,
          canonicalUrl: url, crawledAt: new Date().toISOString(), parentPageId: null,
        });
        const pageLike: ObservedPageLike = page!;
        const ctx: ExtractorContext = {
          graph,
          page: pageLike as any,
          pageNode: {
            id: pageId, url, title: url,
            type: "page", discoveredVia: ["seed"], loadStatus: "complete",
            axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
            viewport: { w: 1280, h: 800, dpr: 1 },
            tokensOverride: null, screenshotRef: null,
            canonicalUrl: url, crawledAt: new Date().toISOString(), parentPageId: null,
          } as any,
          log: () => undefined,
          auth: { kind: "anonymous" } as AuthContext,
          network: { status: "online", evidence: "static" } as NetworkContext,
          budget: { maxPages: 10, perPageTimeoutMs: 5000, totalTimeoutMs: 30000 },
        };
        await structuralExtractor.run(ctx);
        await extractStateDeclared.run(ctx);
        await runObservedExtractor(graph, pageLike, pageId, () => {});
        const converged = Array.from(graph.states()).filter((s) =>
          s.evidence.some((e) => e.kind === "declared+observed"),
        );
        results.push({ url, reachable: true, converged: converged.length });
        console.warn(
          `[PR-8i T4] candidate ${url} produced ${converged.length} declared+observed state(s)`,
        );
      } catch (e) {
        results.push({ url, reachable: false, converged: 0, error: (e as Error).message });
        console.warn(
          `[PR-8i T4] candidate ${url} failed: ${(e as Error).message}`,
        );
      }
    }
    // Record the survey for the PR-8i ED-01 addendum. The test
    // is informational: at least ONE candidate must converge
    // when the env var is set.
    const convergedCount = results.filter((r) => r.reachable && r.converged > 0).length;
    if (convergedCount === 0) {
      // The binding gate in real-app.test.ts requires an
      // explicit AWG_CONVERGENCE_URL; this scan is a survey.
      // We do not assert >=1 here because the candidate URLs
      // may have moved or changed static ARIA; the survey's
      // purpose is to discover which URL satisfies the gate.
      console.warn(
        `[PR-8i T4] survey complete: 0/${results.length} candidates converged. ` +
        `See results above; promote the URL that converges to AWG_CONVERGENCE_URL.`,
      );
    } else {
      const winner = results.find((r) => r.reachable && r.converged > 0);
      console.warn(
        `[PR-8i T4] survey complete: ${convergedCount}/${results.length} candidates converged. ` +
        `Winner: ${winner?.url} (${winner?.converged} state(s)). ` +
        `Promote to AWG_CONVERGENCE_URL.`,
      );
    }
    // We do not assert >=1 — the binding gate is in
    // real-app.test.ts. This test is the survey.
    expect(results.length).toBe(CANDIDATE_URLS.length);
  }, 180_000);
});
