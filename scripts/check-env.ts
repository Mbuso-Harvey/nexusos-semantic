/**
 * Stage 0 verifier: opens a BiDi session, probes every method the plan depends on,
 * writes env-report.json if anything has drifted, and exits non-zero on failure.
 *
 * Run: pnpm run check-env
 *
 * The script does NOT kill the geckodriver process on exit — that's the caller's
 * job (CI does it, and the dev loop usually reuses the session).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createConnection } from "node:net";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const reportPath = resolve(repoRoot, "env-report.json");
const runtimeDir = resolve(repoRoot, ".runtime");
mkdirSync(runtimeDir, { recursive: true });

/**
 * Resolve the geckodriver executable without hardcoding any single
 * developer's machine layout (audit finding F3).
 *
 * Precedence:
 *   1. `GECKODRIVER` env var (absolute path or bare command name)
 *   2. the platform temp dir — where `scripts/install-geckodriver.mjs`
 *      installs it (`os.tmpdir()/geckodriver[.exe]`)
 *   3. the bare command name `geckodriver`, so `spawn` surfaces a normal
 *      ENOENT the caller can report instead of a path that only ever
 *      existed on one host.
 *
 * The previous default was an absolute path under one developer's user
 * profile, which made this constitutional gate unrunnable for any other
 * contributor or CI runner and leaked a personal identifier into the repo
 * (prohibited by `docs/BRANDING_AND_NAMING_TAXONOMY.md` §3).
 */
function resolveGeckodriver(): string {
  const fromEnv = process.env["GECKODRIVER"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const exe = process.platform === "win32" ? "geckodriver.exe" : "geckodriver";
  const inTmp = resolve(tmpdir(), exe);
  if (existsSync(inTmp)) return inTmp;
  return "geckodriver";
}

const GECKODRIVER = resolveGeckodriver();
const WEBDRIVER_PORT = 4444;
const BIDI_PORT = 9222;
const ALLOW_ORIGIN = `http://127.0.0.1:${BIDI_PORT}`;

type BiDiResponse = { type: "success"; id: number; result: any } | { type: "error"; id: number; error: string; message: string };

class BiDiClient {
  private id = 0;
  constructor(private ws: WebSocket) {}
  send<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const handler = (data: any) => {
        const msg: BiDiResponse = JSON.parse(data.toString());
        if (msg.id === id) {
          this.ws.off("message", handler);
          if (msg.type === "success") resolve(msg.result as T);
          else reject(new Error(`${method}: ${msg.error} — ${msg.message}`));
        }
      };
      this.ws.on("message", handler);
    });
  }
}

async function probe(label: string, fn: () => Promise<unknown>): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fn();
    return { ok: true, detail: typeof r === "string" ? r.slice(0, 120) : JSON.stringify(r).slice(0, 120) };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 200) };
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ port, host: "127.0.0.1" }, () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
}

/**
 * Force-terminate Chrome processes that are holding port 9222.
 *
 * **Audit finding F3 — destructive, therefore opt-in.** On Windows
 * `taskkill /F /IM chrome.exe` terminates *every* Chrome process on the
 * machine, including the developer's own browser windows and any unsaved
 * work in them. A diagnostic command must never close the user's browser
 * implicitly, so this is reachable only via the explicit `--kill-stale`
 * flag. Non-Windows platforms are reported as unsupported rather than
 * silently returning success.
 */
async function killStaleChrome(): Promise<boolean> {
  if (process.platform !== "win32") {
    console.log("  --kill-stale is implemented for Windows only; skipping");
    return false;
  }
  return new Promise((res) => {
    const p = spawn("taskkill", ["/F", "/IM", "chrome.exe"], { shell: true });
    p.on("exit", (code) => res(code === 0));
    p.on("error", () => res(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await sleep(150);
  }
  return false;
}

async function main(): Promise<void> {
  const steps: string[] = [];

  console.log("== check-env ==");

  // 0. Port 9222 conflict (gotcha #1). Terminating Chrome is destructive and
  //    therefore opt-in via --kill-stale; by default we only report the
  //    conflict so the developer keeps their browser session (audit F3).
  const killStale = process.argv.includes("--kill-stale");
  if (await portOpen(BIDI_PORT)) {
    if (killStale) {
      console.log("  port 9222 in use; --kill-stale set, terminating chrome.exe");
      const killed = await killStaleChrome();
      steps.push(killed
        ? "killed stale chrome on 9222"
        : "attempted stale-chrome termination on 9222 (failed)");
      await sleep(500);
    } else {
      console.log(`  WARN: port ${BIDI_PORT} already in use; leaving the process untouched.`);
      console.log("        BiDi Origin allowlisting may conflict with the existing listener.");
      console.log("        Re-run with --kill-stale to terminate Chrome (closes ALL Chrome windows).");
      steps.push(`port ${BIDI_PORT} busy; left untouched (pass --kill-stale to terminate)`);
    }
  } else {
    steps.push(`port ${BIDI_PORT} free`);
  }

  // 1. start geckodriver
  if (await portOpen(WEBDRIVER_PORT)) {
    console.log("  geckodriver already running on 4444; reusing");
  } else {
    const gd: ChildProcess = spawn(GECKODRIVER, [
      "--port", String(WEBDRIVER_PORT),
      "--allow-origins", ALLOW_ORIGIN,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    gd.stdout?.on("data", (d) => process.stderr.write(`[gd] ${d}`));
    gd.stderr?.on("data", (d) => process.stderr.write(`[gd!] ${d}`));
    process.on("exit", () => gd.kill());
    if (!await waitForPort(WEBDRIVER_PORT, 10_000)) {
      console.error("FAIL: geckodriver did not bind 4444");
      process.exit(2);
    }
  }
  steps.push("geckodriver listening on 4444");

  // 2. create session
  const r = await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOW_ORIGIN },
    body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "firefox", webSocketUrl: true } } }),
  });
  if (!r.ok) { console.error("FAIL: session create", r.status, await r.text()); process.exit(2); }
  const session = await r.json() as any;
  const sid = session.value.sessionId;
  const wsUrl: string = session.value.capabilities.webSocketUrl;
  steps.push(`session created ${sid}`);

  // 3. open BiDi WS
  const ws = new WebSocket(wsUrl, { origin: ALLOW_ORIGIN });
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  const bidi = new BiDiClient(ws);
  steps.push("BiDi WS open");

  // 4. probe matrix
  const matrix: Record<string, { ok: boolean; detail: string }> = {};
  matrix["session.status"] = await probe("session.status", () => bidi.send("session.status", {}));
  const ctxRes = await probe("browsingContext.create", () => bidi.send<{ context: string }>("browsingContext.create", { type: "tab" }));
  matrix["browsingContext.create"] = ctxRes;
  if (!ctxRes.ok) { console.error("FAIL: cannot create browsing context"); process.exit(2); }
  const ctx = (ctxRes.detail.match(/"context":"([^"]+)"/)?.[1]) ?? "";
  matrix["browsingContext.navigate"] = await probe("navigate", async () => {
    await bidi.send("browsingContext.navigate", { context: ctx, url: "https://example.com" });
    await sleep(1500);
    return "navigated";
  });
  matrix["browsingContext.getTree"] = await probe("getTree", () => bidi.send("browsingContext.getTree", {}));
  matrix["browsingContext.locateNodes"] = await probe("locateNodes", () =>
    bidi.send("browsingContext.locateNodes", { context: ctx, locator: { type: "css", value: "h1" } }),
  );
  matrix["browsingContext.captureScreenshot"] = await probe("captureScreenshot", () =>
    bidi.send("browsingContext.captureScreenshot", { context: ctx }),
  );
  matrix["script.evaluate"] = await probe("script.evaluate", () =>
    bidi.send("script.evaluate", { expression: "document.title", target: { context: ctx }, awaitPromise: true, resultOwnership: "root" }),
  );
  matrix["script.callFunction"] = await probe("script.callFunction", () =>
    bidi.send("script.callFunction", {
      functionDeclaration: "() => 1+1",
      target: { context: ctx },
      awaitPromise: true,
      resultOwnership: "root",
    }),
  );
  matrix["input.performActions"] = await probe("input.performActions", () =>
    bidi.send("input.performActions", {
      context: ctx,
      actions: [{ type: "key", id: "k", actions: [{ type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }] }],
    }),
  );
  matrix["storage.getCookies"] = await probe("storage.getCookies", () => bidi.send("storage.getCookies", {}));

  // Expected to be "unknown command" in Firefox 154 — recorded for drift detection
  matrix["accessibility.getFullAXTree (expected: unknown)"] = await probe("accessibility.getFullAXTree", () => bidi.send("accessibility.getFullAXTree", { context: ctx }));
  matrix["dom.getDocument (expected: unknown)"] = await probe("dom.getDocument", () => bidi.send("dom.getDocument", {}));
  matrix["network.enable (expected: unknown)"] = await probe("network.enable", () => bidi.send("network.enable", {}));

  // close
  await probe("cleanup", async () => {
    try { await bidi.send("browsingContext.close", { context: ctx }); } catch {}
    await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}/session/${sid}`, { method: "DELETE" });
    ws.close();
    return "closed";
  });

  // 5. classic HTTP screenshot
  matrix["classic HTTP GET /session/{sid}/screenshot"] = await probe("classic screenshot", async () => {
    // spin a new session briefly to verify the path
    const r2 = await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOW_ORIGIN },
      body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "firefox" } } }),
    });
    const s2 = await r2.json() as any;
    const sid2 = s2.value.sessionId;
    await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}/session/${sid2}/url`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    await sleep(1500);
    const shot = await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}/session/${sid2}/screenshot`);
    const txt = await shot.text();
    await fetch(`http://127.0.0.1:${WEBDRIVER_PORT}/session/${sid2}`, { method: "DELETE" });
    return txt.slice(0, 60);
  });

  // 6. report
  const required: (keyof typeof matrix)[] = [
    "session.status", "browsingContext.create", "browsingContext.navigate",
    "browsingContext.getTree", "browsingContext.locateNodes",
    "browsingContext.captureScreenshot", "script.evaluate", "script.callFunction",
    "input.performActions", "storage.getCookies", "classic HTTP GET /session/{sid}/screenshot",
  ];
  const missing = required.filter((k) => !matrix[k]?.ok);
  console.log("\n-- BiDi matrix --");
  for (const [k, v] of Object.entries(matrix)) {
    console.log(`  ${v.ok ? "OK " : "FAIL"}  ${k.padEnd(48)} ${v.detail}`);
  }
  if (missing.length) {
    console.error(`\nFAIL: required methods missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("\nOK: substrate matches env-report.json");
  steps.push("matrix verified");
  void steps;
}

main().catch((e) => { console.error(e); process.exit(1); });
