/**
 * PR-8i T1 + T3 — real BiDi same-page causal auth flow.
 *
 * **Acceptance criterion (PR-8i items 1 and 3, verbatim).**
 *  - Implement real same-page causal auth: anonymous page/session;
 *    capture State A; call `applyAuthSpec()` on that same live
 *    `Page`; observe/reload as required; capture State B afterward;
 *    emit the auth successor from those exact two observations; add a
 *    real BiDi integration test proving the sequence.
 *  - Make critical trigger acceptance genuinely live: add real
 *    Firefox/BiDi behavioral proof for at least `choose-dropdown` and
 *    auth. (This file covers the auth half; the choose-dropdown half
 *    is `real-bidi-choose-dropdown.test.ts`.)
 *
 * **Regression protection.**
 *  - State A is materialized on the SAME `Page` object that State B
 *    is materialized on. The orchestrator's `URL × auth-context` loop
 *    (which opens a separate Page per auth context) is NOT used.
 *  - State A and State B have DIFFERENT canonical state ids
 *    (`deriveStateId` includes auth).
 *  - The auth `state:successor` edge is wired with
 *    `triggers: ["auth"]` and `provenance: "bidi:storage.setCookies"`
 *    — the actual BiDi call `applyAuthSpec` made.
 *  - The auth edge is the ONLY `state:successor` edge in the graph
 *    with trigger `auth` (no spurious duplicates).
 *  - Re-running `runCausalAuthFlow` for the same (A, B) pair is
 *    idempotent: edge count stays at 1.
 *  - The function is a no-op for `spec.kind === "anonymous"`.
 *
 * **Test substrate.**
 *  - The test serves a minimal HTML page via `node:http` on a
 *    random localhost port. The page reads `document.cookie` to
 *    decide whether to render the "who" paragraph as `anon` or
 *    `alice`/`bob`/etc. This is fully self-contained: no live
 *    third-party target, no flaky network. The point of the test
 *    is the BiDi cookie + reload + observed extractor sequence,
 *    not a particular target.
 *  - PR-8j T2: the test is now MANDATORY. The previous
 *    `if (skip) return;` skip pattern is removed. When
 *    `AWG_REAL_BIDI=1` is not set OR geckodriver is not on
 *    `127.0.0.1:4444`, the test HARD-FAILS in `beforeAll` via
 *    `throw new Error(...)`. CI MUST install Firefox + geckodriver
 *    and set `AWG_REAL_BIDI=1` for this test to pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createConnection } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { BiDiSession, Page } from "../../src/bidi-client/index.js";
import { Graph } from "../../src/graph/graph.js";
import { runCausalAuthFlow } from "../../src/extract-state/state-materialize.js";
import type { AuthContext, NetworkContext } from "../../src/graph/types.js";
import type { AuthSpec } from "../../src/crawler/auth.js";

async function portOpen(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return await new Promise((res) => {
    const s = createConnection({ port, host }, () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
}

// Minimal HTML page that renders the auth principal from the
// `principal` cookie (set by `applyAuthSpec`). The page exposes a
// `<p id="who">` whose text content reflects the cookie. No JS
// framework — straight DOMContentLoaded.
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>auth-test</title>
</head>
<body>
  <p id="who">anon</p>
  <button id="login" type="button">login</button>
  <script>
    function readWho() {
      const m = document.cookie.match(/(?:^|; )principal=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : "anon";
    }
    function paint() {
      const el = document.getElementById("who");
      if (el) el.textContent = readWho();
    }
    paint();
    document.getElementById("login").addEventListener("click", () => {
      // No-op — the page doesn't actually authenticate; the cookie
      // is the only auth signal. Painting on click is a defensive
      // re-paint in case the cookie is set between DOMContentLoaded
      // and the user interacting.
      paint();
    });
  </script>
</body>
</html>`;

describe("PR-8i T1: real BiDi same-page causal auth", () => {
  let session: BiDiSession | undefined;
  let page: Page | undefined;
  let server: Server | undefined;
  let baseUrl: string = "";
  let route: string = "";

  beforeAll(async () => {
    // PR-8j T2: live BiDi is MANDATORY. The previous skip-on-missing
    // behavior is removed. CI must install Firefox + geckodriver and
    // set `AWG_REAL_BIDI=1`. Missing substrate HARD-FAILS.
    if (process.env.AWG_REAL_BIDI !== "1") {
      throw new Error(
        "[PR-8i T1] AWG_REAL_BIDI!=1; real BiDi auth is mandatory. " +
        "CI must set AWG_REAL_BIDI=1 and install Firefox + geckodriver.",
      );
    }
    if (!(await portOpen(4444))) {
      throw new Error(
        "[PR-8i T1] geckodriver is not reachable on 127.0.0.1:4444; " +
        "real BiDi auth is mandatory. CI must start geckodriver before the test step.",
      );
    }
    // Spin up the minimal HTML server on a random localhost port.
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    route = `${baseUrl}/`;
    // Spin up a BiDi session + Page. Retry up to 6 times on the
    // "Session is already started" race (same pattern as
    // bidi-client/page.test.ts).
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
        console.warn(`[PR-8i T1] BiDi session create failed (attempt ${attempt + 1}/6); waiting ${waitMs}ms: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }, 60_000);

  afterAll(async () => {
    try { await page?.close(); } catch { /* swallow */ }
    try { await session?.close(); } catch { /* swallow */ }
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  });

  it("ACCEPTANCE: A --auth--> B on the same Page, real BiDi", async () => {
    const pageId = `page:${route}`;
    const graph = new Graph();
    // The observed extractor requires a Page node to attach States to
    // (state:on-page edge). Seed it from the same pattern the
    // orchestrator uses.
    graph.upsertPage({
      id: pageId,
      type: "page",
      url: route,
      title: "auth-test",
      discoveredVia: ["pr-8i-test"],
      loadStatus: "complete",
      axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null,
      screenshotRef: null,
      canonicalUrl: route,
      crawledAt: new Date().toISOString(),
      parentPageId: null,
    });
    const spec: AuthSpec = {
      kind: "authenticated",
      principal: "alice",
      session: "session-1",
    };
    const afterAuthExpected: AuthContext = {
      kind: "authenticated",
      principal: "alice",
      session: "session-1",
    };
    const network: NetworkContext = { status: "online", evidence: "page-instrumented" };
    // The full same-page causal flow: A → applyAuthSpec → reload → B
    // → materialize causal auth transition. ONE `Page` object.
    const result = await runCausalAuthFlow({
      graph,
      page: page!,
      pageId,
      route,
      spec,
      baseUrl,
      log: (m) => console.warn(`[flow] ${m}`),
      network,
    });
    // A and B are both materialized.
    expect(result.fromStateId, "before-state id present").not.toBe("");
    expect(result.toStateId, "after-state id present").not.toBe("");
    // A != B (the canonical state-id includes auth).
    expect(result.fromStateId).not.toBe(result.toStateId);
    // Exactly one auth edge was emitted (the first run; re-runs are
    // idempotent — see the next test).
    expect(result.edgeEmitted).toBe(1);
    // The graph contains exactly one state:successor edge with
    // trigger=auth and provenance=bidi:storage.setCookies.
    const authEdges = Array.from(graph.allEdges()).filter(
      (e) => e.kind === "state:successor" &&
             (e.triggers ?? []).includes("auth"),
    );
    expect(authEdges.length, "exactly one auth state:successor edge").toBe(1);
    const authEdge = authEdges[0]!;
    expect(authEdge.from).toBe(result.fromStateId);
    expect(authEdge.to).toBe(result.toStateId);
    expect(authEdge.provenance).toBe("bidi:storage.setCookies");
    // The after-state's auth context matches the spec.
    const afterState = graph.getState(result.toStateId);
    expect(afterState, "after-state is in the graph").toBeDefined();
    expect(afterState!.payload.auth).toEqual(afterAuthExpected);
    // The before-state's auth context is anonymous.
    const beforeState = graph.getState(result.fromStateId);
    expect(beforeState, "before-state is in the graph").toBeDefined();
    expect(beforeState!.payload.auth.kind).toBe("anonymous");
  }, 60_000);

  it("REGRESSION: idempotent — re-running the same flow emits 0 new edges", async () => {
    const pageId = `page:${route}`;
    const graph = new Graph();
    graph.upsertPage({
      id: pageId,
      type: "page",
      url: route,
      title: "auth-test",
      discoveredVia: ["pr-8i-test"],
      loadStatus: "complete",
      axTreeRef: { rootAxId: `ax:${pageId}:root`, provenance: "bidi:script.evaluate" },
      viewport: { w: 1280, h: 800, dpr: 1 },
      tokensOverride: null,
      screenshotRef: null,
      canonicalUrl: route,
      crawledAt: new Date().toISOString(),
      parentPageId: null,
    });
    const spec: AuthSpec = {
      kind: "authenticated",
      principal: "bob",
      session: "session-2",
    };
    const network: NetworkContext = { status: "online", evidence: "page-instrumented" };
    // First call: edgeEmitted = 1.
    const first = await runCausalAuthFlow({
      graph, page: page!, pageId, route, spec, baseUrl, network,
    });
    expect(first.edgeEmitted).toBe(1);
    // Second call: same (A, B) pair → edgeEmitted = 0.
    const second = await runCausalAuthFlow({
      graph, page: page!, pageId, route, spec, baseUrl, network,
    });
    expect(second.edgeEmitted).toBe(0);
    expect(second.fromStateId).toBe(first.fromStateId);
    expect(second.toStateId).toBe(first.toStateId);
    // Exactly one auth edge in the graph.
    const authEdges = Array.from(graph.allEdges()).filter(
      (e) => e.kind === "state:successor" && (e.triggers ?? []).includes("auth"),
    );
    expect(authEdges.length).toBe(1);
  }, 60_000);

  it("REGRESSION: anonymous spec is a no-op (no transition fired)", async () => {
    const pageId = `page:${route}`;
    const graph = new Graph();
    const network: NetworkContext = { status: "online", evidence: "page-instrumented" };
    const beforeCount = graph.stateCount;
    const result = await runCausalAuthFlow({
      graph,
      page: page!,
      pageId,
      route,
      spec: { kind: "anonymous" },
      baseUrl,
      network,
    });
    expect(result.edgeEmitted).toBe(0);
    expect(result.fromStateId).toBe("");
    expect(result.toStateId).toBe("");
    // No new state:successor edge was added.
    const authEdges = Array.from(graph.allEdges()).filter(
      (e) => e.kind === "state:successor" && (e.triggers ?? []).includes("auth"),
    );
    expect(authEdges.length).toBe(0);
    // The graph's state count did not grow (the no-op path does
    // not capture or materialize).
    expect(graph.stateCount).toBe(beforeCount);
  }, 60_000);
});
