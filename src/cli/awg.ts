#!/usr/bin/env node
/**
 * `awg` — the Agent Web Graph CLI. Subcommands:
 *
 *   awg serve [--graph <dir>] [--port N] [--transport stdio|tcp]
 *     Starts the MCP server. Default transport is stdio (the MCP standard).
 *     Use --transport tcp for the line-delimited JSON-RPC 2.0 server.
 *     --graph <dir> loads a graph from disk first (uses GraphStore).
 *
 *   awg crawl <root-url> [--out <dir>] [--max-pages N]
 *     Runs the crawler against a root URL. Writes graph.json + sidecar +
 *     log to --out (default ./crawl-output/).
 *
 *   awg query <method> <json-args> [--graph <dir>]
 *     Loads a graph and calls one method against the MCP server. For ad-hoc
 *     debugging without a persistent client. Method is the MCP tool name
 *     (e.g. "graph_query") and args is a JSON object.
 *
 *   awg demo [--serve] [--out <dir>]
 *     Runs the synthetic demo end-to-end: starts the local demo server,
 *     crawls it, writes graph.json, then optionally serves the resulting
 *     graph over MCP stdio.
 *
 *   awg eval [--target synthetic|github] [--graph-dir <dir>] [--live]
 *     Runs the 5 demo tasks (Stage 17) against a crawled graph, compares
 *     to the per-target fixture, writes demo.trace.json. Use --live to
 *     boot the synthetic demo server + crawl before running.
 *
 *   awg diff <baselineGraphDir> <candidateGraphDir> [--page <pageId>] [--json]
 *     Compares two crawled graph snapshots for visual regressions: layout
 *     shifts, dimension changes, computed-style drift, occlusion regressions,
 *     and design-token detachment, with Core Web Vitals layout-shift scoring
 *     and per-defect severity classification (critical/high/medium/low).
 *
 *   awg tokens [--export-dtcg <file>] [--lint] [--graph <dir>] [--page <pageId>] [--json]
 *     Inspects W3C DTCG design-token bindings on visual nodes. --lint reports
 *     token drift (styling debt) with severity ratings; --export-dtcg writes
 *     a standard DTCG token bundle to <file>.
 *
 *   awg inspect [--graph <dir>] [--json] [--fail-on-diagnostics]
 *               [--max-extractor-failures N]
 *     Reports graph health: page load status, extractor failures, extraction
 *     warnings, unlabeled interactive controls, and pages that produced NO
 *     accessibility tree. `--fail-on-diagnostics` turns the report into a
 *     gate: it exits 1 when any page produced no AxNodes (a silently empty
 *     extraction) or when extractor failures exceed
 *     `--max-extractor-failures` (default 0). This exists because an empty
 *     graph used to exit 0, making a broken extraction indistinguishable
 *     from a healthy one (ED-08 §8 / audit finding F7).
 *
 * Examples:
 *   awg crawl https://example.com --out ./example-crawl
 *   awg serve --graph ./example-crawl
 *   awg query graph_query '{"select":"ax-node","where":{"role":"button"}}' --graph ./example-crawl
 *   awg eval --target synthetic --graph-dir ./demo-crawl-fresh4
 *   awg diff ./baseline-crawl ./candidate-crawl --page "page:/" --json
 *   awg tokens --graph ./example-crawl --lint
 *   awg tokens --graph ./example-crawl --export-dtcg ./tokens.dto.json
 */
import { Crawler, DEFAULT_BUDGET } from "../crawler/orchestrator.js";
import { Graph } from "../graph/graph.js";
import {
  GraphStore,
  SqliteGraphStore,
  loadSubstrate,
  assertGraphHashBinding,
  SubstrateLoadError,
} from "../store/index.js";
import { buildMcpServer, startMcpServer, GraphServer, GraphClient, enforcementActor } from "../server/index.js";
import {
  configureEnforcementFromEnv,
  getEnforcementGateway,
  type EnforcementActor,
  type ImpactLevel,
} from "../security/index.js";
import { runEval } from "../eval/runner.js";
import { BiDiSession } from "../bidi-client/session.js";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { startViewer } from "../viewer/index.js";
import { WindowsUiaDaemon } from "../desktop/windows/uia-daemon.js";
import { captureAndSave } from "../desktop/session-capture.js";
import { AndroidClient } from "../mobile/android/uia2-client.js";
import { MobileSubstrateSurface } from "../substrate/mobile-surface.js";

const args = process.argv.slice(2);
const subcommand = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(name: string): boolean { return args.includes(name); }
function usage(code = 2): never {
  const log = code === 0 ? console.log : console.error;
  log(`Usage:
  awg serve --graph <dir> [--desktop] [--mobile] [--no-bidi] [--port N] [--transport stdio|tcp]
                          [--bidi-url <url>] [--bidi-origin <origin>]
  awg crawl <root-url> [--out <dir>] [--max-pages N]
  awg query <method> <json-args> [--graph <dir>]
  awg inspect [--graph <dir>] [--diagnostics] [--json]
                          [--fail-on-diagnostics] [--max-extractor-failures N]
  awg diff <baselineGraphDir> <candidateGraphDir> [--page <pageId>] [--json]
  awg tokens [--export-dtcg <file>] [--lint] [--graph <dir>] [--page <pageId>] [--json]
  awg doctor [--json]
  awg demo [--serve] [--out <dir>]
  awg eval [--target synthetic|github] [--graph-dir <dir>] [--live]
  awg view [--graph <dir>] [--port N]
  awg desktop [--list | --scrape <titlePattern> | --depth N | --out <file>]
  awg mobile [--devices | --scrape <deviceId> | --out <file>]
  awg session-capture [--launch] [--port N] [--out <file>] [--url-pattern <s>]... [--cookie-domain <s>] [--wait-seconds N] [--json]

Enforcement (§10–§12) — applies to every subcommand; default posture is 'audit'
(read-only). Side-effecting commands need an explicit authorization:
  --posture <audit|copilot|autopilot|red_team|purple_team>
  --authorize-targets <glob,glob>       authorized targets — REQUIRED, non-wildcard, to leave the 'audit' posture
  --authorize-operations <op,op>        authorized operations (default '*')
  --authorize-substrates <s,s>          authorized substrates
  --max-impact <read|modify|destroy|exfiltrate>
  --operator <id>                       actor recorded in the audit trail
  --graph-hash <sha256>                 bind the EngagementManifest to a graph revision
                                        (verified against the loaded substrate — mismatch refuses to start)
  --audit-dir <dir>                     durable, hash-chained audit stream
  --require-durable-audit               fail closed if the audit write fails

BiDi endpoint (R4) — one endpoint per serve process; run one geckodriver per
substrate for parallel live actions:
  --bidi-url <url>                      WebDriver endpoint (default http://127.0.0.1:4444; env AWG_BIDI_URL)
  --bidi-origin <origin>                Origin for the BiDi WS handshake (must match geckodriver --allow-origins; env AWG_BIDI_ORIGIN)
Example:
  awg crawl https://app.example.com --posture autopilot --authorize-targets app.example.com`);
  process.exit(code);
}

// ---- Enforcement (§10–§12) -------------------------------------------------

/**
 * Resolve enforcement configuration for this CLI invocation.
 *
 * CLI flags override the environment. The default posture is `audit`
 * (read-only), so crawling, session capture and kinetic commands are denied
 * until the operator explicitly authorizes them:
 *
 *   awg crawl https://app.example.com --posture autopilot \
 *     --authorize-targets app.example.com
 */
async function bootstrapEnforcementFromCli(): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env };
  const posture = flag("--posture");
  if (posture) env.AWG_POSTURE = posture;
  const targets = flag("--authorize-targets");
  if (targets) env.AWG_AUTHORIZED_TARGETS = targets;
  const operations = flag("--authorize-operations");
  if (operations) env.AWG_AUTHORIZED_OPERATIONS = operations;
  const substrates = flag("--authorize-substrates");
  if (substrates) env.AWG_AUTHORIZED_SUBSTRATES = substrates;
  const maxImpact = flag("--max-impact");
  if (maxImpact) env.AWG_MAX_IMPACT = maxImpact;
  const auditDir = flag("--audit-dir");
  if (auditDir) env.AWG_AUDIT_DIR = resolve(auditDir);
  if (hasFlag("--require-durable-audit")) env.AWG_REQUIRE_DURABLE_AUDIT = "1";
  const graphHash = flag("--graph-hash");
  if (graphHash) env.AWG_GRAPH_HASH = graphHash;
  const operator = flag("--operator");
  env.AWG_ACTOR_ID = operator ?? env.AWG_ACTOR_ID ?? "awg-cli";
  env.AWG_ACTOR_NAME = operator ?? env.AWG_ACTOR_NAME ?? "awg CLI";
  env.AWG_ACTOR_TYPE = operator ? "operator" : env.AWG_ACTOR_TYPE ?? "operator";
  await configureEnforcementFromEnv(env);
}

/** The actor recorded for CLI-driven operations. */
function cliActor(): EnforcementActor {
  const operator = flag("--operator");
  return enforcementActor({
    id: operator ?? process.env.AWG_ACTOR_ID ?? "awg-cli",
    name: operator ?? process.env.AWG_ACTOR_NAME ?? "awg CLI",
    type: "operator",
  });
}

/**
 * Run one CLI operation through the fail-closed enforcement gateway.
 *
 * The callback only runs when the gateway allows the operation; on denial the
 * CLI prints the reason and exits 3 without performing it. Every CLI operation
 * therefore produces an attempt + audit event, allowed or denied (§11).
 */
async function withEnforcement<T>(
  op: {
    tool?: string;
    method?: string;
    target?: string;
    impact?: ImpactLevel;
    confirm?: boolean;
    details?: string;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  const result = await getEnforcementGateway().request<T>(
    { ...op, actor: cliActor() },
    run,
  );
  if (!result.allowed) {
    console.error(
      `[awg] denied (${result.denialKind ?? "denied"}): ${result.reason}`,
    );
    // §11: persist the denial to the durable audit stream before exiting
    // (`process.exit` skips `beforeExit`).
    const stream = getEnforcementGateway().getAuditStream();
    if (stream) await stream.flush().catch(() => undefined);
    process.exit(3);
  }
  if (result.error !== undefined) throw result.error;
  return result.result as T;
}


async function cmdServe() {
  // R1 (§2.4 / §6): the substrate must be named explicitly and must exist.
  // The historical `?? "./crawl-output"` + `new Graph()` fallback silently
  // served an empty graph — the root cause of demo-crawl artifacts being
  // served as if they were the live surface. No implicit default, ever.
  const outDir = flag("--graph") ?? flag("--out");
  if (!outDir) {
    console.error(
      `[awg] serve requires an explicit substrate: pass --graph <dir> (the directory containing graph.json).\n` +
        `[awg] No implicit default is allowed — agents must name the substrate they act on.\n` +
        `[awg] Produce one first if needed: awg crawl <url> --out <dir> --posture autopilot --authorize-targets <host>`,
    );
    process.exit(2);
  }
  const port = Number(flag("--port") ?? "0");
  const transport = flag("--transport") ?? "stdio";
  const enableDesktop = hasFlag("--desktop");
  const enableMobile = hasFlag("--mobile");
  const noBidi = hasFlag("--no-bidi");

  let graph: Graph;
  try {
    const loaded = await loadSubstrate(resolve(outDir));
    graph = loaded.graph;
    const prov = loaded.provenance;
    console.error(
      `[awg] substrate: ${prov.crawl?.rootUrl ?? "(unknown root)"} | crawled ${prov.crawl?.finishedAt ?? "(unknown time)"} | hash ${prov.graphHash?.slice(0, 16) ?? "(none)"} | nexus ${prov.buildVersion}`,
    );
  } catch (err) {
    if (err instanceof SubstrateLoadError) {
      console.error(`[awg] ${err.code}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // R2: bind enforcement to the *verified* substrate hash. An operator-asserted
  // AWG_GRAPH_HASH / --graph-hash must match what was actually loaded, or the
  // process refuses to start (§2.4 — no silent substitutions).
  try {
    assertGraphHashBinding(graph.substrateProvenance, process.env.AWG_GRAPH_HASH);
  } catch (err) {
    if (err instanceof SubstrateLoadError) {
      console.error(`[awg] ${err.code}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  // When the operator did not assert a hash, bind the manifest to the computed
  // one so every audit event carries the real substrate revision (§12).
  const prov = graph.substrateProvenance;
  if (prov?.graphHash) getEnforcementGateway().rebindGraphHash(prov.graphHash);

  const bidiEndpoint = resolveBidiEndpoint();
  let bidi: { session: BiDiSession; page: any } | undefined;
  if (!noBidi) {
    try {
      bidi = await openBidi();
    } catch (e: any) {
      if (enableDesktop || enableMobile) {
        console.error(`[awg] Notice: BiDi session not attached (${e.message}). Serving with ${enableDesktop ? "desktop " : ""}${enableMobile ? "mobile " : ""}substrate.`);
      } else {
        console.error(`[awg] cannot open BiDi session (ED-02 requires a live geckodriver on ${bidiEndpoint.webDriverBase}): ${e.message}`);
        console.error(`[awg] hint: start geckodriver on ${bidiEndpoint.webDriverBase} before running \`awg serve\`, or pass --bidi-url <url>, or pass --desktop / --mobile / --no-bidi.`);
        process.exit(1);
      }
    }
  }

  if (transport === "stdio") {
    const { stop } = await startMcpServer(graph, {
      bidi,
      desktop: enableDesktop,
      mobile: enableMobile,
      // R5: async substrate production is opt-in — producing a substrate is
      // an impact-modify act that must be an explicit operator choice.
      crawlJobs: hasFlag("--allow-crawl"),
    });
    const cleanup = async () => {
      await stop();
      if (bidi) await bidi.session.close();
    };
    process.on("SIGTERM", () => { void cleanup(); });
    process.on("SIGINT", () => { void cleanup(); });
    // Terminate when the controlling stdio client disconnects (stdin EOF), so a
    // spawned Nexus process never outlives its MCP parent (F-009 teardown fix).
    process.stdin.on("end", () => {
      void cleanup().finally(() => process.exit(0));
    });
    process.stdin.on("close", () => {
      void cleanup().finally(() => process.exit(0));
    });
    // Keep alive — StdioServerTransport owns stdin/stdout
    await new Promise(() => undefined);
  } else if (transport === "tcp") {
    if (!bidi) {
      console.error(`[awg] tcp transport currently requires BiDi session`);
      process.exit(1);
    }
    const srv = new GraphServer(graph, bidi);
    const addr = await srv.start(port || 0);
    console.error(`[awg] serving ${gauge(graph)} on tcp://${addr.host}:${addr.port} (BiDi attached)`);
    const cleanup = async () => { await srv.stop(); await bidi.session.close(); };
    process.on("SIGTERM", () => { void cleanup(); });
    process.on("SIGINT", () => { void cleanup(); });
    await new Promise(() => undefined);
  } else {
    console.error(`unknown transport: ${transport}`);
    process.exit(2);
  }
}

/**
 * R4: resolve the WebDriver BiDi endpoint from `--bidi-url` / `AWG_BIDI_URL`
 * and the WebSocket handshake origin from `--bidi-origin` / `AWG_BIDI_ORIGIN`.
 *
 * The historical hard-coded `127.0.0.1:4444` made parallel live actions
 * impossible from the CLI: every `serve` process contended on one geckodriver.
 * One endpoint per substrate process, ports managed by the operator, is the
 * intended parallelism model (no dispatcher — that would be the single point
 * of failure).
 */
function resolveBidiEndpoint(): { webDriverBase: string; bidiOrigin: string } {
  const webDriverBase = (flag("--bidi-url") ?? process.env.AWG_BIDI_URL ?? "http://127.0.0.1:4444").replace(/\/+$/, "");
  const bidiOrigin = flag("--bidi-origin") ?? process.env.AWG_BIDI_ORIGIN ?? "http://127.0.0.1:9222";
  return { webDriverBase, bidiOrigin };
}

/**
 * Open a BiDi session + a long-lived tab and return the
 * `BidiContext` the server attaches for the duration of the
 * MCP connection. Wrapped in a helper so `cmdServe` can
 * surface a clear error on the failure path. Uses the configured
 * endpoint (`--bidi-url` / `AWG_BIDI_URL`), not a hard-coded one.
 */
async function openBidi() {
  const { webDriverBase, bidiOrigin } = resolveBidiEndpoint();
  const session = await BiDiSession.create("firefox", { webDriverBase, bidiOrigin });
  const page = await session.newPage();
  return { session, page };
}

async function cmdCrawl() {
  const rootUrl = args[1];
  if (!rootUrl) usage();
  const outDir = resolve(flag("--out") ?? "./crawl-output");
  const maxPages = Number(flag("--max-pages") ?? "50");
  const authFile = flag("--auth-file") ? resolve(flag("--auth-file")!) : undefined;
  const useSqlite = hasFlag("--sqlite") || flag("--store") === "sqlite";
  const store = useSqlite ? new SqliteGraphStore(outDir) : new GraphStore(outDir);
  const graph = new Graph();
  const crawler = new Crawler(graph, {
    rootUrl,
    budget: { ...DEFAULT_BUDGET, maxPages },
    authFile,
  });
  const crawlStartedAt = Date.now();
  const result = await withEnforcement(
    { tool: "crawl", target: rootUrl, impact: "modify", details: `crawl ${rootUrl}` },
    () => crawler.crawl(),
  );
  await store.save(graph, {
    rootUrl,
    startedAt: new Date(crawlStartedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    browser: { engine: "firefox", version: result.browserVersion ?? "unknown" },
  });
  console.error(`[awg] crawled ${result.pages} pages; graph saved to ${outDir}`);
}

async function cmdQuery() {
  const method = args[1];
  const jsonArgs = args[2];
  if (!method || !jsonArgs) usage();
  const outDir = resolve(flag("--graph") ?? "./crawl-output");
  const useSqlite = hasFlag("--sqlite") || flag("--store") === "sqlite" || existsSync(resolve(outDir, "graph.sqlite3"));
  const store = useSqlite ? new SqliteGraphStore(outDir) : new GraphStore(outDir);
  const graph = await store.load();
  const server = new GraphServer(graph);
  const params = JSON.parse(jsonArgs);
  const res = await server.dispatch({ jsonrpc: "2.0", id: 1, method, params });
  console.log(JSON.stringify(res, null, 2));
  if (res.error) process.exit(1);
}

async function cmdDemo() {
  const outDir = resolve(flag("--out") ?? "./demo-crawl");
  const serve = hasFlag("--serve");
  // 1. Start the synthetic demo server (background)
  const demoPath = resolve("./demo/saas/server.cjs");
  const demoPort = Number(process.env.AWG_DEMO_PORT ?? 7311);
  const server: ChildProcess = spawn("node", [demoPath], {
    env: { ...process.env, PORT: String(demoPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (b) => process.stderr.write(`[demo] ${b}`));
  // Wait for "listening on" line
  await new Promise<void>((resolve) => {
    server.stdout?.on("data", (b: Buffer) => {
      if (b.toString().includes("listening on")) resolve();
    });
    setTimeout(resolve, 2000);  // fallback
  });
  // 2. Crawl it
  const rootUrl = `http://127.0.0.1:${demoPort}/`;
  const store = new GraphStore(outDir);
  const graph = new Graph();
  const crawler = new Crawler(graph, { rootUrl });
  const crawlStartedAt = Date.now();
  const result = await withEnforcement(
    { tool: "crawl", target: rootUrl, impact: "modify", details: `demo crawl ${rootUrl}` },
    () => crawler.crawl(),
  );
  await store.save(graph, {
    rootUrl,
    startedAt: new Date(crawlStartedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    browser: { engine: "firefox", version: result.browserVersion ?? "unknown" },
  });
  console.error(`[awg] demo crawled ${result.pages} pages; graph.json written to ${store.graphPath}`);
  if (serve) {
    const { stop } = await startMcpServer(graph);
    process.on("SIGTERM", () => { void stop(); server.kill(); });
    process.on("SIGINT", () => { void stop(); server.kill(); });
    await new Promise(() => undefined);
  } else {
    server.kill();
  }
}

function gauge(g: Graph): string {
  return `pages=${g.pageCount} ax=${g.axCount} vis=${g.visualCount} edges=${g.edgeCount} caps=${g.capabilityCount}`;
}

async function cmdEval() {
  const target = (flag("--target") ?? "synthetic") as "synthetic" | "github";
  const outDir = resolve(flag("--graph-dir") ?? `./demo-crawl-${target}`);
  if (hasFlag("--live")) {
    if (target !== "synthetic") {
      console.error(`[awg] --live is only wired for the synthetic target; got "${target}"`);
      process.exit(2);
    }
    // Boot the demo server, crawl, save graph — same as `awg demo`.
    await cmdDemo();
  }
  const trace = await runEval({ graphDir: outDir, target });
  const s = trace.summary;
  console.error(
    `[awg] eval: ${s.passed}/${s.passed + s.failed} passed, ${s.skipped} skipped, ${s.overBudget} over budget`,
  );
  console.error(`[awg] trace written to ${outDir}/demo.trace.json`);
  for (const t of trace.tasks) {
    const tag = t.skipped ? "SKIP" : t.pass ? "PASS" : "FAIL";
    console.error(`  [${tag}] ${t.id.padEnd(16)} ${t.durationMs.toFixed(1).padStart(7)}ms  ${t.withinBudget ? "≤budget" : "OVER BUDGET"}`);
  }
  if (s.failed > 0) process.exit(1);
}

async function cmdDesktop() {
  if (process.platform !== "win32") {
    console.error("[awg] desktop automation currently requires Windows host environment");
    process.exit(1);
  }
  const daemon = new WindowsUiaDaemon();
  if (hasFlag("--list") || args.length === 1) {
    console.error("[awg] Enumerating active desktop windows...");
    const windows = await daemon.listWindows();
    console.log(JSON.stringify(windows, null, 2));
    return;
  }

  const pattern = flag("--scrape") ?? flag("--pattern") ?? "Code";
  const depth = Number(flag("--depth") ?? "8");
  const outFile = flag("--out") ?? "./desktop-scrape.json";

  console.error(`[awg] Scraping desktop window matching pattern: '${pattern}' (depth: ${depth})...`);
  const surface = await daemon.createSurface(pattern);
  const [route, metrics, title, axTree] = await Promise.all([
    surface.getRoute(),
    surface.getDisplayMetrics(),
    surface.getTitle(),
    surface.extractAccessibilityTree(),
  ]);

  const stats: Record<string, number> = {};
  function tally(nodes: any[]) {
    for (const n of nodes) {
      stats[n.role] = (stats[n.role] || 0) + 1;
      if (n.children) tally(n.children);
    }
  }
  tally(axTree);

  const payload = {
    title,
    route,
    metrics,
    elementCount: Object.values(stats).reduce((a, b) => a + b, 0),
    roleBreakdown: stats,
    axTree,
  };

  writeFileSync(resolve(outFile), JSON.stringify(payload, null, 2), "utf8");
  console.error(`[awg] Scraped: "${title}"`);
  console.error(`[awg] Route: ${route}`);
  console.error(`[awg] Total elements: ${payload.elementCount}`);
  console.error(`[awg] Role breakdown:`, stats);
  console.error(`[awg] Output written to ${outFile}`);
}

async function cmdMobile() {
  const client = new AndroidClient();

  if (hasFlag("--devices") || hasFlag("-l")) {
    console.error("[awg] Discovering attached mobile devices via ADB...");
    try {
      const devices = await client.listDevices();
      if (devices.length === 0) {
        console.log("No mobile devices found.");
      } else {
        console.log(JSON.stringify(devices, null, 2));
      }
    } catch (err: any) {
      console.error(`[awg] Notice: Android ADB tool not accessible (${err.message}). Ensure Android SDK platform-tools / adb is installed in your PATH.`);
    }
    return;
  }

  const deviceId = flag("--scrape") ?? flag("--device");
  if (deviceId) {
    client.setDevice(deviceId);
  }
  const outFile = flag("--out") ?? "./mobile-scrape.json";

  console.error(`[awg] Scraping mobile device UI (target: ${deviceId ?? "first available"})...`);
  try {
    const surface = new MobileSubstrateSurface("mobile-android", deviceId ?? "default-device", client);
    const [route, metrics, title, axTree] = await withEnforcement(
      {
        tool: "mobile_scrape_device",
        target: deviceId ?? "default-device",
        impact: "read",
        details: "mobile scrape",
      },
      () =>
        Promise.all([
          surface.getRoute(),
          surface.getDisplayMetrics(),
          surface.getTitle(),
          surface.extractAccessibilityTree(),
        ]),
    );

    const stats: Record<string, number> = {};
    function tally(nodes: any[]) {
      for (const n of nodes) {
        stats[n.role] = (stats[n.role] || 0) + 1;
        if (n.children) tally(n.children);
      }
    }
    tally(axTree);

    const payload = {
      title,
      route,
      metrics,
      elementCount: Object.values(stats).reduce((a, b) => a + b, 0),
      roleBreakdown: stats,
      axTree,
    };

    writeFileSync(resolve(outFile), JSON.stringify(payload, null, 2), "utf8");
    console.error(`[awg] Scraped: "${title}"`);
    console.error(`[awg] Route: ${route}`);
    console.error(`[awg] Total elements: ${payload.elementCount}`);
    console.error(`[awg] Role breakdown:`, stats);
    console.error(`[awg] Output written to ${outFile}`);
  } catch (err: any) {
    console.error(`[awg] Failed to scrape mobile surface: ${err.message}`);
  }
}
async function cmdView() {
  const outDir = resolve(flag("--graph") ?? flag("--out") ?? "./crawl-output");
  const port = Number(flag("--port") ?? "0");
  const viewer = await startViewer({ graphDir: outDir, port });
  console.error(`[awg] awg-viewer on ${viewer.url}`);
  console.error(`[awg] (press Ctrl-C to stop)`);
  const stop = async () => { await viewer.stop(); process.exit(0); };
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  await new Promise(() => undefined);
}

async function cmdDiff() {
  const baseDir = args[1];
  const candDir = args[2];
  if (!baseDir || !candDir) {
    console.error("Usage: awg diff <baselineGraphDir> <candidateGraphDir> [--page <pageId>] [--json]");
    process.exit(1);
  }
  const pageId = flag("--page");
  const isJson = hasFlag("--json");

  const baseStore = existsSync(resolve(baseDir, "graph.sqlite3"))
    ? new SqliteGraphStore(resolve(baseDir))
    : new GraphStore(resolve(baseDir));
  const candStore = existsSync(resolve(candDir, "graph.sqlite3"))
    ? new SqliteGraphStore(resolve(candDir))
    : new GraphStore(resolve(candDir));

  if (!(await baseStore.exists()) || !(await candStore.exists())) {
    console.error("[awg] One or both graph directories do not contain a valid graph.");
    process.exit(1);
  }

  const baseGraph = await baseStore.load();
  const candGraph = await candStore.load();

  const targetPages = pageId ? [pageId] : Array.from(baseGraph.pages()).map((p) => p.id);
  const reports = targetPages.map((pid) => candGraph.diffVisualRegression(baseGraph, pid));

  if (isJson) {
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
    return;
  }

  console.log(`\n======================================================`);
  console.log(`  Agent Web Graph — Visual Regression Diff Report`);
  console.log(`======================================================`);
  for (const rep of reports) {
    const isRegressed = rep.regressedNodesCount > 0;
    console.log(`Page: ${rep.pageId}`);
    console.log(`  Cumulative Layout Shift (CLS): ${rep.cumulativeLayoutShift.toFixed(4)}`);
    console.log(`  Regressed: ${isRegressed ? "YES" : "NO"}`);
    console.log(`  Defects: Critical=${rep.counts.critical}, High=${rep.counts.high}, Medium=${rep.counts.medium}, Low=${rep.counts.low}`);
    console.log(`  Nodes: Total=${rep.totalNodesCompared}, Regressed=${rep.regressedNodesCount}, Added=${rep.addedNodes.length}, Removed=${rep.removedNodes.length}`);
    const allDefects = rep.nodeDiffs.flatMap((d) => d.defects);
    if (allDefects.length > 0) {
      console.log(`  Top Defects:`);
      for (const d of allDefects.slice(0, 10)) {
        console.log(`    [${d.severity.toUpperCase()}] ${d.kind}: ${d.description}`);
      }
    }
    console.log(`------------------------------------------------------`);
  }
  console.log(`======================================================\n`);
}

async function cmdTokens() {
  const outDir = resolve(flag("--graph") ?? flag("--out") ?? "./crawl-output");
  const store = existsSync(resolve(outDir, "graph.sqlite3"))
    ? new SqliteGraphStore(outDir)
    : new GraphStore(outDir);
  if (!(await store.exists())) {
    console.error(`[awg] No graph found in ${outDir}.`);
    process.exit(1);
  }
  const graph = await store.load();
  const isJson = hasFlag("--json");
  const exportFile = flag("--export-dtcg");
  const doLint = hasFlag("--lint");
  const pageId = flag("--page");

  if (exportFile) {
    const bundle = graph.exportDtcgTokens();
    writeFileSync(resolve(exportFile), JSON.stringify(bundle, null, 2), "utf8");
    console.error(`[awg] Exported ${bundle.metadata.totalTokens} DTCG tokens to ${exportFile}`);
    return;
  }

  if (doLint) {
    const drifts = graph.lintTokenDrift(pageId);
    if (isJson) {
      console.log(JSON.stringify(drifts, null, 2));
      return;
    }
    console.log(`\n======================================================`);
    console.log(`  Agent Web Graph — Design Token Drift Lint`);
    console.log(`======================================================`);
    console.log(`Total Drifts Found: ${drifts.length}`);
    for (const d of drifts.slice(0, 20)) {
      console.log(`  [${d.severity.toUpperCase()}] ${d.property} on ${d.axId} (${d.pageId})`);
      console.log(`    Actual: ${d.actualValue} -> Suggested: ${d.suggestedToken} (${d.suggestedValue}) [delta=${d.driftDelta}]`);
      console.log(`    Message: ${d.message}`);
    }
    if (drifts.length > 20) {
      console.log(`  ... and ${drifts.length - 20} more drifts.`);
    }
    console.log(`======================================================\n`);
    return;
  }

  // Default: list tokens
  const tokens = graph.getTokens();
  if (isJson) {
    console.log(JSON.stringify(Object.fromEntries(tokens), null, 2));
  } else {
    console.log(`Design tokens in graph (${tokens.size}):`);
    for (const [name, val] of tokens) {
      console.log(`  ${name}: ${JSON.stringify(val)}`);
    }
  }
}


async function cmdInspect() {
  const outDir = resolve(flag("--graph") ?? flag("--out") ?? "./crawl-output");
  const useSqlite = hasFlag("--sqlite") || flag("--store") === "sqlite" || existsSync(resolve(outDir, "graph.sqlite3"));
  const store = useSqlite ? new SqliteGraphStore(outDir) : new GraphStore(outDir);
  if (!(await store.exists())) {
    console.error(`[awg] No graph found in ${outDir}. Please run 'awg crawl <url> --out ${outDir}' first.`);
    process.exit(1);
  }
  const graph = await store.load();
  const diag = graph.getDiagnostics();

  const pages = Array.from(graph.pages());
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
    "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider",
  ]);
  const unlabeledInteractive: Array<{ id: string; role: string; pageId: string }> = [];
  for (const node of graph.allNodes()) {
    if (node.type === "ax-node") {
      const ax = node as any;
      if (INTERACTIVE_ROLES.has(ax.role) && (!ax.name || ax.name.trim() === "")) {
        unlabeledInteractive.push({ id: ax.id, role: ax.role, pageId: ax.pageId });
      }
    }
  }

  const failedPages = pages.filter((p) => p.loadStatus && p.loadStatus !== "complete");

  // ED-08 §8 (audit finding F7): a page with zero AxNodes is a *silently*
  // empty extraction. Distinguish it from a healthy page so the report and
  // the `--fail-on-diagnostics` gate can surface it. Derived from the graph
  // every run (no persisted field, no migration).
  const pagesWithNoAxTree = pages.filter((p) => graph.axByPage(p.id).length === 0);

  let healthScore = 100;
  healthScore -= failedPages.length * 25;
  healthScore -= diag.extractorFailures.length * 10;
  healthScore -= diag.extractionWarnings.length * 2;
  healthScore -= unlabeledInteractive.length * 1;
  healthScore = Math.max(0, Math.min(100, healthScore));

  const recommendations: string[] = [];
  if (failedPages.length > 0) {
    recommendations.push(`${failedPages.length} page(s) failed to load or timed out. Inspect failedPages.`);
  }
  if (diag.extractorFailures.length > 0) {
    recommendations.push(`${diag.extractorFailures.length} extractor failure(s) recorded.`);
  }
  if (diag.extractionWarnings.length > 0) {
    recommendations.push(`${diag.extractionWarnings.length} DOM element(s) had extraction warnings / fallbacks.`);
  }
  if (unlabeledInteractive.length > 0) {
    recommendations.push(`${unlabeledInteractive.length} interactive element(s) lack accessible names.`);
  }
  if (pagesWithNoAxTree.length > 0) {
    recommendations.push(
      `${pagesWithNoAxTree.length} page(s) produced NO accessibility tree (0 AxNodes). This is a silently empty extraction, not an empty page — re-run with diagnostics enabled and inspect extractorFailures.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push("All systems healthy. Graph is complete and ready for agent reasoning.");
  }

  const result = {
    graphDir: outDir,
    summary: {
      healthScorePercent: healthScore,
      pagesTotal: pages.length,
      pagesLoaded: pages.length - failedPages.length,
      pagesFailed: failedPages.length,
      pagesWithNoAxTree: pagesWithNoAxTree.length,
      axNodesTotal: graph.axCount,
      capabilitiesTotal: graph.capabilityCount,
      statesTotal: graph.stateCount,
      edgesTotal: graph.edgeCount,
    },
    failedPages: failedPages.map((p) => ({ url: p.url, loadStatus: p.loadStatus })),
    pagesWithNoAxTree: pagesWithNoAxTree.map((p) => ({ id: p.id, url: p.url })),
    extractorFailures: diag.extractorFailures,
    extractionWarnings: diag.extractionWarnings,
    unlabeledInteractive: unlabeledInteractive.slice(0, 20).map((a) => ({ id: a.id, role: a.role, pageId: a.pageId })),
    recommendations,
  };

  if (hasFlag("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n======================================================`);
    console.log(`  Agent Web Graph — Inspection & Diagnostics Report`);
    console.log(`======================================================`);
    console.log(`  Target directory:   ${outDir}`);
    console.log(`  Overall Health:     ${healthScore}% ${healthScore >= 90 ? "[EXCELLENT]" : healthScore >= 70 ? "[FAIR]" : "[NEEDS ATTENTION]"}`);
    console.log(`  Pages:              ${result.summary.pagesLoaded}/${result.summary.pagesTotal} loaded (${result.summary.pagesFailed} failed)`);
    console.log(`  Accessibility Nodes:${result.summary.axNodesTotal}`);
    console.log(`  Declared Caps:      ${result.summary.capabilitiesTotal}`);
    console.log(`  Observed States:    ${result.summary.statesTotal}`);
    console.log(`  Graph Edges:        ${result.summary.edgesTotal}`);
    console.log(`------------------------------------------------------`);
    console.log(`  Diagnostics:`);
    console.log(`    Extractor Failures:  ${diag.extractorFailures.length}`);
    console.log(`    Extraction Warnings: ${diag.extractionWarnings.length}`);
    console.log(`    Unlabeled Controls:  ${unlabeledInteractive.length}`);
    console.log(`    Empty Ax Trees:      ${pagesWithNoAxTree.length}`);
    console.log(`------------------------------------------------------`);
    console.log(`  Recommendations:`);
    for (const rec of recommendations) {
      console.log(`    • ${rec}`);
    }
    console.log(`======================================================\n`);
  }

  // ED-08 §8 (audit finding F7): `--fail-on-diagnostics` turns the report
  // into a gate. A crawl that silently produced an empty graph must not be
  // able to exit 0 in CI or in a scripted audit. `--max-extractor-failures`
  // raises the tolerance for extractor failures (default 0); pages with no
  // AxNodes are always a failure because that is precisely the silent
  // failure mode this gate exists to catch.
  if (hasFlag("--fail-on-diagnostics")) {
    const maxExtractorFailures = Number(flag("--max-extractor-failures") ?? 0) || 0;
    const problems: string[] = [];
    if (pagesWithNoAxTree.length > 0) {
      problems.push(`${pagesWithNoAxTree.length} page(s) produced no accessibility tree`);
    }
    if (diag.extractorFailures.length > maxExtractorFailures) {
      problems.push(`${diag.extractorFailures.length} extractor failure(s) exceeds threshold ${maxExtractorFailures}`);
    }
    if (problems.length > 0) {
      console.error(`[awg] --fail-on-diagnostics: ${problems.join("; ")}`);
      process.exit(1);
    }
  }
}

async function cmdDoctor() {
  const isJson = hasFlag("--json");
  const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; message: string }> = [];

  // 1. Node.js runtime
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1).split(".")[0] ?? "0", 10);
  if (major >= 22) {
    checks.push({ name: "Node.js Runtime", status: "ok", message: `${nodeVer} (compatible >= 22)` });
  } else {
    checks.push({ name: "Node.js Runtime", status: "warn", message: `${nodeVer} (recommended >= 22)` });
  }

  // 2. Web Substrate (BiDi / Geckodriver) — probed at the configured endpoint
  //    (R4: --bidi-url / AWG_BIDI_URL, not a hard-coded 4444).
  const bidiEndpoint = resolveBidiEndpoint();
  const bidiTarget = (() => {
    try {
      const u = new URL(bidiEndpoint.webDriverBase);
      return { host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), label: `${u.hostname}:${Number(u.port) || (u.protocol === "https:" ? 443 : 80)}` };
    } catch {
      return { host: "127.0.0.1", port: 4444, label: bidiEndpoint.webDriverBase };
    }
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: bidiTarget.host, port: bidiTarget.port }, () => {
        socket.end();
        resolve();
      });
      socket.setTimeout(800);
      socket.on("timeout", () => { socket.destroy(); reject(new Error("Timeout")); });
      socket.on("error", (e) => reject(e));
    });
    checks.push({ name: "Web Substrate (BiDi)", status: "ok", message: `Listening on ${bidiTarget.label}` });
  } catch {
    checks.push({
      name: "Web Substrate (BiDi)",
      status: "warn",
      message: `No WebDriver BiDi endpoint detected on ${bidiTarget.label} (start geckodriver there — or point --bidi-url / AWG_BIDI_URL at a live endpoint — for web automation)`,
    });
  }

  // 3. Desktop Substrate
  if (process.platform === "win32") {
    try {
      const psVer = execSync("powershell -NoProfile -Command \"$PSVersionTable.PSVersion.Major\"", { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      checks.push({ name: "Desktop Substrate (Windows UIA)", status: "ok", message: `PowerShell v${psVer} active with UI Automation bridge support` });
    } catch (err: any) {
      checks.push({ name: "Desktop Substrate (Windows UIA)", status: "warn", message: `PowerShell execution failed: ${err.message}` });
    }
  } else if (process.platform === "darwin") {
    checks.push({ name: "Desktop Substrate (macOS AX)", status: "ok", message: "macOS Accessibility API available" });
  } else {
    checks.push({ name: "Desktop Substrate", status: "warn", message: `Unsupported platform (${process.platform}) - desktop automation requires Windows or macOS` });
  }

  // 4. Mobile Substrate (ADB)
  try {
    const adbVer = execSync("adb version", { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const match = adbVer.match(/version\s+([\d.]+)/i);
    const verStr = match ? match[1] : "detected";
    checks.push({ name: "Mobile Substrate (Android ADB)", status: "ok", message: `Android Debug Bridge ${verStr} available in PATH` });
  } catch {
    checks.push({
      name: "Mobile Substrate (Android ADB)",
      status: "warn",
      message: "adb not found in PATH (install Android SDK platform-tools to automate mobile devices)",
    });
  }

  // 5. Output / File System
  try {
    const testFile = resolve("./.awg-doctor-probe.tmp");
    writeFileSync(testFile, "ok", "utf8");
    unlinkSync(testFile);
    checks.push({ name: "Storage & Workspace", status: "ok", message: "Workspace filesystem is writable" });
  } catch (err: any) {
    checks.push({ name: "Storage & Workspace", status: "fail", message: `Workspace write failed: ${err.message}` });
  }

  // 6. SQLite Relational Engine
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as any;
    const probeDb = new DatabaseSync(":memory:");
    probeDb.exec("CREATE TABLE probe (ok INT);");
    probeDb.close();
    checks.push({ name: "SQLite Storage Engine", status: "ok", message: "Native node:sqlite DatabaseSync operational" });
  } catch (err: any) {
    checks.push({ name: "SQLite Storage Engine", status: "warn", message: `node:sqlite unavailable: ${err.message}` });
  }

  if (isJson) {
    console.log(JSON.stringify({ ok: !checks.some((c) => c.status === "fail"), checks }, null, 2));
    return;
  }

  console.log(`\n======================================================`);
  console.log(`  Agent Web Graph — System & Substrate Doctor`);
  console.log(`======================================================`);
  for (const c of checks) {
    const tag = c.status === "ok" ? "[  OK  ]" : c.status === "warn" ? "[ WARN ]" : "[ FAIL ]";
    console.log(`  ${tag} ${c.name.padEnd(32)} ${c.message}`);
  }
  console.log(`------------------------------------------------------`);
  const anyFails = checks.some((c) => c.status === "fail");
  if (anyFails) {
    console.log(`  Doctor status: Critical issues detected that prevent operation.`);
    process.exit(1);
  } else {
    console.log(`  Doctor status: System is healthy and operational.`);
  }
  console.log(`======================================================\n`);
}
async function cmdSessionCapture() {
  const hasFlag = (n: string) => process.argv.includes(n);
  const flag = (n: string) => {
    const i = process.argv.indexOf(n);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
  };
  const launch = hasFlag("--launch");
  const port = Number(flag("--port") ?? "9222");
  const outFile = flag("--out") ?? "./auth-state.json";
  const json = hasFlag("--json");
  const waitSeconds = Number(flag("--wait-seconds") ?? "0");
  const urlPatterns: string[] = [];
  for (const a of process.argv) {
    if (a.startsWith("--url-pattern=")) urlPatterns.push(a.slice("--url-pattern=".length));
  }
  const cookieDomain = flag("--cookie-domain");

  const opts: import("../desktop/session-capture.js").LaunchCaptureOptions = {
    launch,
    port,
    urlPatterns: urlPatterns.length > 0 ? urlPatterns : undefined,
    cookieDomainFilter: cookieDomain,
    waitSeconds: waitSeconds > 0 ? waitSeconds : undefined,
  };

  const { state, launched } = await withEnforcement(
    {
      tool: "session_capture",
      target: cookieDomain ?? "session",
      impact: "exfiltrate",
      details: `session capture -> ${outFile}`,
    },
    () => captureAndSave(outFile, opts),
  );
  if (launched) {
    console.error(`[session-capture] launched debug Chrome (pid ${launched.pid}, port ${launched.port}).`);
    console.error(`[session-capture] close that Chrome window when done; it uses an isolated profile.`);
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, file: outFile, cookies: state.cookies.length, origins: state.origins?.length ?? 0 }, null, 2));
  } else {
    console.log(`[session-capture] saved ${state.cookies.length} cookies, ${state.origins?.length ?? 0} storage origins -> ${outFile}`);
    console.log(`[session-capture] replay: awg crawl <url> --auth-file ${outFile}`);
  }
}


(async () => {
  try {
    // §12: bind posture/authorization/audit before any subcommand runs.
    await bootstrapEnforcementFromCli();
    switch (subcommand) {
      case "help":
      case "--help":
      case "-h":
        usage(0);
      case "serve": await cmdServe(); break;
      case "crawl": await cmdCrawl(); break;
      case "query": await cmdQuery(); break;
      case "inspect": await cmdInspect(); break;
      case "diff": await cmdDiff(); break;
      case "tokens": await cmdTokens(); break;
      case "doctor": await cmdDoctor(); break;
      case "demo":  await cmdDemo();  break;
      case "eval":  await cmdEval();  break;
      case "view":
      case "viewer":
        await cmdView();
        break;
      case "desktop": await cmdDesktop(); break;
      case "mobile": await cmdMobile(); break;
      case "session-capture": await cmdSessionCapture(); break;
      default: usage();
    }
  } catch (e) {
    console.error(`[awg] ${(e as Error).message}`);
    process.exit(1);
  }
})();



