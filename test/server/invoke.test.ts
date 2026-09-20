/**
 * ED-02 / PR-9 — graph.invoke tests.
 *
 * The execute path is gated by the same security tier decision
 * as `graph.act` (see `src/graph/security.ts:67-86` and
 * `src/graph/tools.ts:773-805`). The execute step itself is in
 * `src/server/invoke.ts`.
 *
 * **Test posture (per PR-8i T2).** Live BiDi tests are MANDATORY
 * when the substrate is required. `beforeAll` HARD-FAILS (not
 * skips) when `AWG_REAL_BIDI !== "1"` or when geckodriver is not
 * reachable. CI must install Firefox + geckodriver and set
 * `AWG_REAL_BIDI=1` for the live tests to pass.
 *
 * **Test split.**
 *   1. `graph.invoke` refuses a CONFIRM capability without
 *      `confirm: true` — pure decision, no BiDi required.
 *   2. `graph.act` (decision-only) does not execute and returns
 *      the same shape as v1 — pure decision, no BiDi required.
 *   3. `graph.invoke` returns "no BiDi session attached" when
 *      the server was built without a `bidi` option — no BiDi
 *      required; uses the no-BiDi dispatch path.
 *   4. `graph.invoke` (dry-run, `execute: false`) returns the
 *      decision + binding without touching the page — no BiDi
 *      required (the dry-run short-circuits before any page
 *      access).
 *   5. `graph.invoke` executes an EXECUTE capability on a real
 *      BiDi page served from a local HTTP fixture — live BiDi
 *      required (hard-fail in `beforeAll`).
 *   6. `graph.invoke` returns "selector did not resolve" when
 *      the binding's selector no longer matches — live BiDi
 *      required.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { BiDiSession, Page } from "../../src/bidi-client/index.js";
import { Graph } from "../../src/graph/graph.js";
import type { PageNode, AxNode, Capability } from "../../src/graph/types.js";
import { GraphServer } from "../../src/server/server.js";
import { invokeCapability } from "../../src/server/invoke.js";
import {
  SecurityPosture,
  configureEnforcement,
  getEnforcementGateway,
} from "../../src/security/index.js";

function seed(g: Graph) {
  g.upsertPage({
    id: "page:/", type: "page", url: "https://example.com/", title: "Example",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
    viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
  });
  g.upsertAx({
    id: "ax:root", type: "ax-node", pageId: "page:/", role: "region", name: "Example",
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
  });
  g.upsertAx({
    id: "ax:btn", type: "ax-node", pageId: "page:/", role: "button", name: "Sign up",
    nameSource: "aria-label",
    states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
    properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
    apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 1, parentAxId: null, provenance: "aria:t",
  });
  g.upsertCapability({
    id: "cap:sign", type: "capability", name: "sign_up", description: "Sign up",
    inputSchema: {}, outputSchema: {}, source: "fallback",
    binding: { kind: "ax-node", axId: "ax:btn", selector: "[data-cap=sign_up]" },
    security: "EXECUTE", provenance: "declared:t", pageId: "page:/",
  });
  g.upsertCapability({
    id: "cap:del", type: "capability", name: "delete_account", description: "Delete account",
    inputSchema: {}, outputSchema: {}, source: "fallback",
    binding: { kind: "ax-node", axId: "ax:btn", selector: "[data-cap=del]" },
    security: "CONFIRM", provenance: "declared:t", pageId: "page:/",
  });
}

async function portOpen(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return await new Promise((res) => {
    const s = createConnection({ port, host }, () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
}

// Minimal HTML page that mounts the elements the live test needs.
// The page has a button with `data-cap=sign_up` and a `data-step`
// paragraph the test can read to confirm the click fired.
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>invoke-test</title>
</head>
<body>
  <button data-cap="sign_up" aria-label="Sign up">Sign up</button>
  <p data-step="0" id="step">0</p>
  <script>
    const btn = document.querySelector('[data-cap=sign_up]');
    const step = document.getElementById('step');
    let n = 0;
    if (btn) btn.addEventListener('click', () => { n += 1; if (step) step.setAttribute('data-step', String(n)); });
  </script>
</body>
</html>`;

// --- Pure-decision tests (no BiDi required) -----------------------------

describe("graph.invoke: decision-only paths (no BiDi required)", () => {
  it("refuses a CONFIRM capability without confirm:true", async () => {
    const g = new Graph();
    seed(g);
    const srv = new GraphServer(g);
    const res: any = await srv.dispatch({
      jsonrpc: "2.0", id: 1, method: "graph.invoke",
      params: { capabilityId: "cap:del", input: {} },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.ok).toBe(false);
    expect(res.result.decision.requireConfirm).toBe(true);
  });

  it("graph.act (decision-only) returns the same shape as v1 and does not execute", async () => {
    const g = new Graph();
    seed(g);
    const srv = new GraphServer(g);
    const res: any = await srv.dispatch({
      jsonrpc: "2.0", id: 1, method: "graph.act",
      params: { capabilityId: "cap:sign", input: {} },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.ok).toBe(true);
    expect(res.result.tier).toBe("EXECUTE");
    expect(res.result.binding.selector).toBe("[data-cap=sign_up]");
    // v1 shape preserved: no `observe` field (decision-only).
    expect(res.result.observe).toBeUndefined();
  });

  it("graph.invoke returns a clean error when the server has no BiDi context", async () => {
    const g = new Graph();
    seed(g);
    const srv = new GraphServer(g); // no bidi attached
    const res: any = await srv.dispatch({
      jsonrpc: "2.0", id: 1, method: "graph.invoke",
      params: { capabilityId: "cap:sign", input: {} },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.ok).toBe(false);
    expect(res.result.observe.error).toMatch(/no page attached/);
  });

  it("graph.invoke with execute:false returns the decision without touching the page", async () => {
    const g = new Graph();
    seed(g);
    const srv = new GraphServer(g);
    const res: any = await srv.dispatch({
      jsonrpc: "2.0", id: 1, method: "graph.invoke",
      params: { capabilityId: "cap:sign", input: {}, execute: false },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.ok).toBe(true);
    expect(res.result.tier).toBe("EXECUTE");
    expect(res.result.binding.selector).toBe("[data-cap=sign_up]");
    // Dry-run: no execute path was taken; no live URL captured.
    expect(res.result.observe.url).toBeNull();
  });
});

// --- Live-BiDi tests (substrate mandatory) ------------------------------

describe("graph.invoke: live BiDi (AWG_REAL_BIDI required)", () => {
  let session: BiDiSession | undefined;
  let page: Page | undefined;
  let httpServer: Server | undefined;
  let baseUrl: string = "";

  beforeAll(async () => {
    if (process.env.AWG_REAL_BIDI !== "1") {
      throw new Error(
        "[PR-9] AWG_REAL_BIDI!=1; real BiDi invoke is mandatory. " +
        "CI must set AWG_REAL_BIDI=1 and install Firefox + geckodriver.",
      );
    }
    const open = await portOpen(4444);
    if (!open) {
      throw new Error(
        "[PR-9] geckodriver not reachable on 127.0.0.1:4444; " +
        "real BiDi invoke is mandatory. CI must start geckodriver before the test step.",
      );
    }
    // Start a tiny HTTP server that serves the page fixture.
    httpServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_HTML);
    });
    await new Promise<void>((res) => httpServer!.listen(0, "127.0.0.1", () => res()));
    const addr = httpServer.address();
    if (typeof addr === "object" && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}/`;
    }
    session = await BiDiSession.create();
    page = await session.newPage();

    // §10–§12: the execute path is enforced below MCP, and the default posture
    // is AUDIT (read-only). These live tests therefore establish the operator
    // authorization an engagement carries: AUTOPILOT + wildcard web scope.
    await configureEnforcement(
      {
        posture: SecurityPosture.AUTOPILOT,
        targets: ["*"],
        operations: ["*"],
        substrates: ["web"],
        maxImpact: "modify",
        requireDurableAudit: false,
        actor: { id: "ci-operator", name: "CI Operator", type: "operator" },
      },
      getEnforcementGateway(),
    );
  });

  afterAll(async () => {
    if (page) await page.close();
    if (session) await session.close();
    if (httpServer) await new Promise<void>((res) => httpServer!.close(() => res()));
  });

  it("executes an EXECUTE capability on the live page (button click)", async () => {
    const g = new Graph();
    seed(g);
    // Override the pageId's URL to point at the local fixture so the
    // executor navigates the BiDi tab to it.
    g.getPage("page:/")!.canonicalUrl = baseUrl;
    const res: any = await invokeCapability(g, page!, {
      capabilityId: "cap:sign", input: {},
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe("EXECUTE");
    expect(res.binding.selector).toBe("[data-cap=sign_up]");
    expect(typeof res.observe.elapsedMs).toBe("number");
    expect(res.observe.url).toBe(baseUrl);
    // The click fired — read the data-step attribute the page updated.
    const step = await page!.script.evaluate<number>(
      page!.target,
      "Number(document.getElementById('step').getAttribute('data-step'))",
    );
    expect(step).toBe(1);
  });

  it("returns 'selector did not resolve' when the binding's selector no longer matches", async () => {
    const g = new Graph();
    seed(g);
    g.getPage("page:/")!.canonicalUrl = baseUrl;
    // Mutate the capability to a selector that does not exist on the page.
    g.getCapability("cap:sign")!.binding.selector = "[data-cap=does_not_exist]";
    const res: any = await invokeCapability(g, page!, {
      capabilityId: "cap:sign", input: {},
    });
    expect(res.ok).toBe(false);
    expect(res.observe.error).toMatch(/selector did not resolve/);
  });
});
