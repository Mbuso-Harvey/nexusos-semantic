#!/usr/bin/env node
/**
 * run-ledger.mjs — Evidence Ledger runner (ED-10).
 *
 * Runs the capability battery against each target in `verification/targets/`,
 * records every artifact a reviewer needs (crawl log, graph, inspect report,
 * robots.txt authorization snapshot, per-query battery transcript), and
 * regenerates `verification/LEDGER.md` deterministically from the recorded
 * results.
 *
 * Authorization doctrine (ED-10) — a target may be crawled only if it is:
 *   - "owned": an in-repo synthetic app started by this runner on loopback, or
 *   - "self-hosted-oss": an OSS container this runner starts on loopback, or
 *   - "permissioned-public": documentation/spec surfaces whose published
 *     purpose is testing/reference, hard-capped by manifest budget, robots.txt
 *     snapshotted per run, and never gating ("evidence only"), or
 *   - "design-partner": a signed Authorization-to-Test exists (see
 *     verification/ATT-TEMPLATE.md). NOT automated by this runner.
 * Arbitrary third-party crawling is out of scope by design; ED-10 records the
 * rationale (unauthorised-access exposure, reproducibility, and marketplace
 * credibility for a security vendor).
 *
 * Exit codes:
 *   0  every authoritative target PASSed (skips allowed without --strict)
 *   1  any authoritative target FAILed, or (with --strict) was skipped
 *   2  harness misuse (bad manifest, unknown target, internal error)
 * Evidence-only targets (authoritative:false) NEVER affect the exit code.
 *
 * Usage:
 *   node scripts/run-ledger.mjs                  # all targets
 *   node scripts/run-ledger.mjs --target demo-saas
 *   node scripts/run-ledger.mjs --strict         # CI mode: skips are failures
 *   node scripts/run-ledger.mjs --list
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const targetsDir = join(repoRoot, "verification", "targets");
const runsRoot = join(repoRoot, "verification", "runs");
const ledgerPath = join(repoRoot, "verification", "LEDGER.md");

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const listOnly = argv.includes("--list");
const targetIdx = argv.indexOf("--target");
const onlyIdx = argv.indexOf("--only"); // alias, kept for the README spelling
const only = targetIdx >= 0 ? argv[targetIdx + 1] : onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

/** Run the awg CLI (same entry as `pnpm awg`) and capture everything. */
function awg(args, timeoutMs = 600_000) {
  return spawnSync(process.execPath, [tsx, "src/cli/awg.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Run docker, capture everything. */
function docker(args, timeoutMs = 120_000) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Parse the first JSON object found in a mostly-stdout string. */
function parseJsonLoose(s) {
  if (!s) return null;
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** Poll a TCP endpoint until it accepts connections or the budget runs out. */
function waitTcp(host, port, timeoutMs) {
  return new Promise((yes) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect({ host, port });
      const done = (ok) => {
        s.destroy();
        yes(ok);
      };
      s.once("connect", () => done(true));
      s.once("error", () => {
        s.destroy();
        if (Date.now() >= deadline) yes(false);
        else setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

/** Probe the BiDi substrate endpoint (AWG_BIDI_URL or 127.0.0.1:4444). */
async function bidiEndpointReachable() {
  let host = "127.0.0.1";
  let port = 4444;
  try {
    const u = new URL(process.env.AWG_BIDI_URL ?? "ws://127.0.0.1:4444");
    host = u.hostname;
    port = Number(u.port) || 4444;
  } catch {
    /* keep defaults */
  }
  return await waitTcp(host, port, 3000);
}

function loadManifests() {
  if (!existsSync(targetsDir)) {
    console.error("[ledger] no verification/targets directory");
    process.exit(2);
  }
  const files = readdirSync(targetsDir).filter((f) => f.endsWith(".json")).sort();
  const manifests = files.map((f) => JSON.parse(readFileSync(join(targetsDir, f), "utf8")));
  if (!manifests.length) {
    console.error("[ledger] no target manifests found");
    process.exit(2);
  }
  if (only && !manifests.some((m) => m.slug === only)) {
    console.error(`[ledger] unknown target '${only}'. Known: ${manifests.map((m) => m.slug).join(", ")}`);
    process.exit(2);
  }
  return manifests.filter((m) => !only || m.slug === only);
}

/**
 * Skip: an environmental or authorization precondition was not met. The
 * verdict records SKIP; under `--strict` an authoritative skip fails the
 * run (ED-10 §3).
 */
class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Skip";
  }
}

/** Filesystem-safe timestamp for run directories. */
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

const pkgJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const envBlock = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cli: `${pkgJson.name}@${pkgJson.version}`,
  entry: "tsx src/cli/awg.ts",
};

/**
 * Fetch and evaluate robots.txt for a permissioned-public target
 * (ED-10 §3): an unreachable robots.txt or an explicit `Disallow: /`
 * for `User-agent: *` means NO authorization — the target is skipped.
 * The body's sha256 is recorded as the authorization snapshot.
 */
async function fetchRobots(manifest) {
  const u = new URL(manifest.target.url);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(robotsUrl, { signal: ac.signal, redirect: "follow" });
    const body = res.ok ? await res.text() : null;
    if (!res.ok || body == null) {
      return { ok: false, url: robotsUrl, status: res.status, sha256: null, disallowAll: false, error: `robots.txt not retrievable (HTTP ${res.status})` };
    }
    // Minimal robots.txt evaluation: does a `User-agent: *` group carry
    // `Disallow: /` (or the wildcard form `Disallow: *`)?
    let inStar = false;
    let disallowAll = false;
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      const m = /^(\S+?)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "user-agent") inStar = value === "*";
      else if (key === "disallow" && inStar && (value === "/" || value === "*")) disallowAll = true;
    }
    return { ok: true, url: robotsUrl, status: res.status, sha256: createHash("sha256").update(body).digest("hex"), disallowAll };
  } catch (e) {
    return { ok: false, url: robotsUrl, status: 0, sha256: null, disallowAll: false, error: `robots.txt fetch failed: ${e?.message ?? String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

function dockerAvailable() {
  try {
    // stdio: "ignore" is deliberate (2026-09-17 hang fix): spawnSync waits for
    // the child's stdio pipes to close, and the Docker Desktop CLI shim can
    // leave a grandchild holding an inherited pipe — which hung the ledger
    // indefinitely on a machine where the engine is stopped. We only need the
    // exit status, so no pipes are created and the timeout can actually fire.
    return spawnSync("docker", ["--version"], { stdio: "ignore", timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * True iff the docker DAEMON is reachable (`docker info`), not just the CLI
 * binary. A stopped Docker Desktop/Engine is an environment condition — per
 * ED-10 §3 (Docker absent → SKIP, not FAIL) it must skip the target, while a
 * pull/run failure with the daemon UP is a genuine failure and still fails.
 * (2026-09-16: the ledger run failed httpbin/juice-shop on this machine
 * because the CLI was present but the daemon was not running.)
 */
function dockerDaemonAvailable() {
  try {
    return spawnSync("docker", ["info", "--format", "ok"], { stdio: "ignore", timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
}

/** The image sha256 actually started (reproducibility pin, ED-10 §3). */
function containerImageSha(name) {
  const r = spawnSync("docker", ["inspect", "--format", "{{.Image}}", name], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Kill a process we started, and (on POSIX) its whole group. */
function killOwnedProcess(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", timeout: 30_000 });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { process.kill(child.pid, "SIGTERM"); }
    }
  } catch { /* already dead */ }
}

/**
 * Capability battery (ED-10 §1): a fixed set of READ-only graph queries
 * executed against the produced substrate through the real CLI. The
 * transcript (query, ok, hitCount) is committed evidence.
 */
const BATTERY_QUERIES = [
  { name: "pages", query: { select: "page" } },
  { name: "links", query: { select: "ax-node", where: { role: "link" } } },
  { name: "buttons", query: { select: "ax-node", where: { role: "button" } } },
  { name: "states", query: { select: "state" } },
];

function runBattery(graphDir) {
  return BATTERY_QUERIES.map(({ name, query }) => {
    const r = awg(["query", "graph_query", JSON.stringify(query), "--graph", graphDir], 120_000);
    const parsed = parseJsonLoose(r.stdout);
    const rpcError = parsed?.error ?? null;
    let hitCount = null;
    if (!rpcError && parsed) {
      const payload = parsed.result ?? parsed;
      if (Array.isArray(payload?.hits)) hitCount = payload.hits.length;
      else if (Array.isArray(payload)) hitCount = payload.length;
      else if (Array.isArray(parsed?.hits)) hitCount = parsed.hits.length;
    }
    return {
      name,
      query,
      ok: r.status === 0 && !!parsed && !rpcError,
      hitCount,
      error: rpcError
        ? String(rpcError.message ?? rpcError)
        : r.status !== 0
          ? (r.stderr || "").trim().slice(0, 300)
          : parsed ? null : "unparseable output",
    };
  });
}

/**
 * Run one target end-to-end per ED-10 §1/§3: authorization pre-flight →
 * bring-up → `awg crawl` → `awg inspect --json --fail-on-diagnostics` →
 * capability battery → threshold evaluation → guaranteed teardown.
 */
async function runTarget(manifest) {
  const slug = manifest.slug;
  const runDir = join(runsRoot, slug, isoStamp());
  mkdirSync(runDir, { recursive: true });
  const log = (msg) => {
    try { appendFileSync(join(runDir, "runner.log"), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* best-effort */ }
    console.error(`[ledger:${slug}] ${msg}`);
  };

  const result = {
    slug,
    name: manifest.name,
    class: manifest.class,
    authoritative: manifest.authoritative === true,
    target: manifest.target,
    ranAt: new Date().toISOString(),
    verdict: "PENDING",
    skipReason: null,
    error: null,
    checks: [],
    battery: null,
    robots: null,
    imageDigest: null,
    summary: null,
    diagnostics: null,
  };
  let containerName = null;
  let ownedProc = null;

  try {
    // 1. Substrate pre-flight — no BiDi substrate means no crawl, for anyone.
    if (!(await bidiEndpointReachable())) {
      throw new Skip(`BiDi substrate unreachable at ${process.env.AWG_BIDI_URL ?? "ws://127.0.0.1:4444"} — start geckodriver first (see the ci.yml bootstrap)`);
    }
    // 2. Authorization pre-flight (permissioned-public, ED-10 §3): robots.txt
    //    is fetched and recorded BEFORE any crawl. Unreachable or deny-all
    //    robots.txt skips the target — no authorization, no crawl.
    if (manifest.robots?.check) {
      const robots = await fetchRobots(manifest);
      result.robots = robots;
      if (!robots.ok) throw new Skip(`${robots.error ?? "robots.txt unavailable"} — no authorization, no crawl`);
      if (robots.disallowAll) throw new Skip("robots.txt: `Disallow: /` for `User-agent: *` — target off-limits");
      log(`robots.txt ok (sha256 ${robots.sha256.slice(0, 16)}…)`);
    }
    // 3. Bring-up (container and/or owned app).
    const cont = manifest.container;
    if (cont) {
      if (!dockerAvailable()) throw new Skip("docker CLI unavailable — cannot start self-hosted-oss target");
      if (!dockerDaemonAvailable()) throw new Skip("docker daemon unreachable (docker info failed) — environment, not product; start Docker Desktop / the engine and re-run (ED-10 §3)");
      const pull = docker(["pull", cont.image], 300_000);
      log(`docker pull ${cont.image}: exit ${pull.status}`);
      if (pull.status !== 0) throw new Error(`docker pull failed: ${(pull.stderr || pull.stdout || "").trim().slice(0, 300)}`);
      containerName = cont.name;
      const run = docker(["run", "-d", "--name", cont.name, "-p", `127.0.0.1:${cont.hostPort}:${cont.containerPort}`, cont.image], 60_000);
      log(`docker run ${cont.name}: exit ${run.status}`);
      if (run.status !== 0) throw new Error(`docker run failed: ${(run.stderr || "").trim().slice(0, 300)}`);
      if (!(await waitTcp(cont.waitTcp.host, cont.waitTcp.port, cont.waitTcp.timeoutMs ?? 60_000))) {
        throw new Error(`container did not open ${cont.waitTcp.host}:${cont.waitTcp.port} within ${cont.waitTcp.timeoutMs}ms`);
      }
      result.imageDigest = containerImageSha(cont.name);
      log(`container up; image sha: ${result.imageDigest ?? "unresolvable"}`);
    }
    const start = manifest.start;
    if (start?.command) {
      const parts = start.command.split(/\s+/).filter(Boolean);
      const serverLogFd = openSync(join(runDir, "server.log"), "a");
      ownedProc = spawn(parts[0], parts.slice(1), { cwd: repoRoot, detached: true, stdio: ["ignore", serverLogFd, serverLogFd] });
      closeSync(serverLogFd);
      if (!(await waitTcp(start.waitTcp.host, start.waitTcp.port, start.waitTcp.timeoutMs ?? 20_000))) {
        throw new Error(`owned app did not open ${start.waitTcp.host}:${start.waitTcp.port} within ${start.waitTcp.timeoutMs}ms (see server.log)`);
      }
      log(`owned app up (pid ${ownedProc.pid})`);
    }
    // 4. Crawl.
    const graphDir = join(runDir, "graph");
    mkdirSync(graphDir, { recursive: true });
    log(`awg crawl ${manifest.target.url} (maxPages ${manifest.crawl.maxPages}, posture ${manifest.crawl.posture})`);
    const crawl = awg([
      "crawl", manifest.target.url,
      "--out", graphDir,
      "--max-pages", String(manifest.crawl.maxPages),
      "--posture", String(manifest.crawl.posture ?? "autopilot"),
      "--authorize-targets", String(manifest.crawl.authorizeTargets),
    ], 600_000);
    writeFileSync(join(runDir, "crawl.stdout.txt"), crawl.stdout ?? "");
    writeFileSync(join(runDir, "crawl.stderr.txt"), crawl.stderr ?? "");
    log(`awg crawl exit ${crawl.status}`);
    if (crawl.status !== 0) {
      throw new Error(`awg crawl exited ${crawl.status}: ${(crawl.stderr || "").trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 400)}`);
    }
    // 5. Inspect gate (audit finding F7): a silently empty or failed
    //    extraction fails here instead of masquerading as a healthy graph.
    const inspect = awg([
      "inspect", "--graph", graphDir, "--json", "--fail-on-diagnostics",
      "--max-extractor-failures", String(manifest.expect.maxExtractorFailures ?? 0),
    ], 120_000);
    const inspectJson = parseJsonLoose(inspect.stdout);
    if (inspectJson) writeFileSync(join(runDir, "inspect.json"), JSON.stringify(inspectJson, null, 2));
    log(`awg inspect exit ${inspect.status}`);
    if (inspect.status !== 0) throw new Error(`awg inspect --fail-on-diagnostics failed: ${(inspect.stderr || "").trim().slice(0, 400)}`);
    if (!inspectJson?.summary) throw new Error("awg inspect --json produced no summary object");
    result.summary = inspectJson.summary;
    result.diagnostics = {
      failedPages: inspectJson.failedPages ?? [],
      pagesWithNoAxTree: inspectJson.pagesWithNoAxTree ?? [],
      extractorFailures: inspectJson.extractorFailures ?? [],
      extractionWarnings: (inspectJson.extractionWarnings ?? []).slice(0, 50),
      recommendations: inspectJson.recommendations ?? [],
    };
    // 6. Capability battery (READ-only graph queries through the CLI).
    result.battery = runBattery(graphDir);
    writeFileSync(join(runDir, "battery.json"), JSON.stringify(result.battery, null, 2));
    for (const b of result.battery) log(`battery ${b.name}: ${b.ok ? `ok (${b.hitCount ?? "?"} hits)` : `ERROR ${b.error}`}`);
    // 7. Threshold evaluation (manifest `expect` block).
    const e = manifest.expect;
    const s = inspectJson.summary;
    const extractorFailureCount = Array.isArray(inspectJson.extractorFailures) ? inspectJson.extractorFailures.length : 0;
    result.checks = [
      { field: "pagesTotal", expect: `>= ${e.minPages}`, actual: s.pagesTotal, pass: s.pagesTotal >= e.minPages },
      { field: "axNodesTotal", expect: `>= ${e.minAxNodes}`, actual: s.axNodesTotal, pass: s.axNodesTotal >= e.minAxNodes },
      { field: "statesTotal", expect: `>= ${e.minStates}`, actual: s.statesTotal, pass: s.statesTotal >= e.minStates },
      { field: "edgesTotal", expect: `>= ${e.minEdges}`, actual: s.edgesTotal, pass: s.edgesTotal >= e.minEdges },
      { field: "healthScorePercent", expect: `>= ${e.healthScoreMin}`, actual: s.healthScorePercent, pass: s.healthScorePercent >= e.healthScoreMin },
      { field: "extractorFailures", expect: `<= ${e.maxExtractorFailures}`, actual: extractorFailureCount, pass: extractorFailureCount <= e.maxExtractorFailures },
    ];
    const failedChecks = result.checks.filter((c) => !c.pass);
    if (failedChecks.length > 0) {
      throw new Error(`threshold failures: ${failedChecks.map((c) => `${c.field}=${c.actual} (expected ${c.expect})`).join("; ")}`);
    }
    const batteryError = result.battery.find((b) => !b.ok);
    if (batteryError && result.authoritative) {
      throw new Error(`capability battery error on '${batteryError.name}': ${batteryError.error}`);
    }
    result.verdict = "PASS";
    log(`verdict PASS (health ${s.healthScorePercent}%, ${s.pagesTotal} pages, ${s.axNodesTotal} ax-nodes)`);
  } catch (err) {
    if (err instanceof Skip) {
      result.verdict = "SKIP";
      result.skipReason = err.message;
      log(`SKIP — ${err.message}`);
    } else {
      result.verdict = "FAIL";
      result.error = String(err?.message ?? err);
      log(`FAIL — ${result.error}`);
    }
  } finally {
    // Guaranteed teardown (ED-10 §3): runs even when a step threw.
    if (containerName) {
      const rm = docker(["rm", "-f", containerName], 60_000);
      log(`teardown docker rm -f ${containerName}: exit ${rm.status}`);
    }
    if (ownedProc) {
      killOwnedProcess(ownedProc);
      log(`teardown owned app (pid ${ownedProc.pid ?? "?"})`);
    }
    result.environment = { ...envBlock, strict, bidiUrl: process.env.AWG_BIDI_URL ?? "ws://127.0.0.1:4444" };
    result.runDir = relative(repoRoot, runDir).split("\\").join("/");
    try { writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2)); } catch { /* best-effort */ }
    mkdirSync(join(repoRoot, "verification", "results"), { recursive: true });
    writeFileSync(join(repoRoot, "verification", "results", `${slug}.json`), JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}

/**
 * Load every committed per-target result (`verification/results/*.json`).
 * LEDGER.md is regenerated from ALL results, so the record accumulates
 * across runs (ED-10 §3).
 */
function loadCommittedResults() {
  const dir = join(repoRoot, "verification", "results");
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const slug = f.replace(/\.json$/, "");
    try {
      out.set(slug, JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      out.set(slug, { slug, verdict: "CORRUPT", summary: null });
    }
  }
  return out;
}

/** Regenerate `verification/LEDGER.md` deterministically (ED-09 §3). */
function regenerateLedger() {
  const manifests = loadManifests();
  const results = loadCommittedResults();
  const lines = [];
  lines.push("# Evidence Ledger — real-target validation record");
  lines.push("");
  lines.push("> **MACHINE-GENERATED — DO NOT EDIT BY HAND (ED-09 §3).** Regenerated");
  lines.push("> deterministically from `verification/results/*.json` by");
  lines.push("> `scripts/run-ledger.mjs`. The per-target result files are the");
  lines.push("> authoritative record; this table is derived from them.");
  lines.push("");
  lines.push("| Target | Class | Gating | Budget | Verdict | Pages | Ax nodes | States | Health % | Ext. failures | Robots | Image | Ran at (UTC) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  let pass = 0, fail = 0, skip = 0, none = 0;
  for (const m of manifests) {
    const r = results.get(m.slug);
    if (!r || r.verdict === "CORRUPT") {
      none++;
      lines.push(`| ${m.slug} | ${m.class} | ${m.authoritative ? "yes" : "no"} | ${m.crawl.maxPages}p | ${r ? "CORRUPT RESULT FILE" : "— no run recorded —"} | — | — | — | — | — | — | — | — |`);
      continue;
    }
    if (r.verdict === "PASS") pass++;
    else if (r.verdict === "FAIL") fail++;
    else if (r.verdict === "SKIP") skip++;
    else none++;
    const s = r.summary ?? {};
    const cells = [
      r.slug ?? m.slug,
      r.class ?? m.class,
      r.authoritative ? "yes" : "no",
      `${m.crawl.maxPages}p`,
      r.verdict,
      s.pagesTotal ?? "—",
      s.axNodesTotal ?? "—",
      s.statesTotal ?? "—",
      s.healthScorePercent ?? "—",
      r.checks?.find((c) => c.field === "extractorFailures")?.actual ?? "—",
      r.robots ? (r.robots.ok ? (r.robots.disallowAll ? "deny-all (skipped)" : "recorded, allowed") : `fetch failed (${r.robots.error ?? "n/a"})`) : "n/a",
      r.imageDigest ? `\`${String(r.imageDigest).slice(0, 19)}…\`` : "n/a",
      r.ranAt ?? "—",
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(`**Totals:** ${pass} PASS · ${fail} FAIL · ${skip} SKIP · ${none} no recorded run.`);
  lines.push("");
  if (fail > 0) {
    lines.push("> ⚠ Gating target(s) recorded FAIL — see the per-target result files and ED-09 §4.");
    lines.push("");
  }
  lines.push("A SKIP records an unmet environmental or authorization precondition (BiDi");
  lines.push("substrate down, Docker absent, or a robots.txt refusal). Evidence-only targets");
  lines.push("(`permissioned-public`) never affect the nightly gate (ED-09 §4).");
  lines.push("");
  writeFileSync(ledgerPath, lines.join("\n"));
}

async function main() {
  const manifests = loadManifests();
  if (listOnly) {
    console.log("slug\tclass\tgating\tbudget\turl");
    for (const m of manifests) {
      console.log(`${m.slug}\t${m.class}\t${m.authoritative ? "yes" : "no"}\t${m.crawl.maxPages}p\t${m.target.url}`);
    }
    return 0;
  }
  mkdirSync(join(repoRoot, "verification", "runs"), { recursive: true });
  for (const m of manifests) {
    await runTarget(m);
  }
  regenerateLedger();
  const results = loadCommittedResults();
  let exitCode = 0;
  for (const m of manifests) {
    const r = results.get(m.slug);
    if (!m.authoritative || !r) continue;
    if (r.verdict === "FAIL") {
      console.error(`[ledger] authoritative target '${m.slug}' FAILED`);
      exitCode = 1;
    } else if (strict && r.verdict === "SKIP") {
      console.error(`[ledger] --strict: authoritative target '${m.slug}' was skipped`);
      exitCode = 1;
    }
  }
  console.error("[ledger] results written to verification/results/; LEDGER.md regenerated");
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[ledger] harness error: ${e?.stack ?? e}`);
    process.exit(2);
  });
