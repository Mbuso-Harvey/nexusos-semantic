#!/usr/bin/env node
/**
 * MCP live smoke test — proves the stdio MCP server answers a real
 * JSON-RPC client conversation, the same way Claude Desktop / Cursor /
 * any MCP host would drive it.
 *
 * What it exercises, verbatim on the wire:
 *   1. `initialize` handshake (protocol negotiation + serverInfo)
 *   2. `notifications/initialized` (the required follow-up notification)
 *   3. `tools/list` (discovery — asserts the canonical underscore names)
 *   4. `tools/call graph_query` (find nodes by where-clause)
 *   5. `tools/call graph_path` (traversal — children of the root)
 *   6. `tools/call graph_explain` (self-documentation surface)
 *
 * Usage:  node scripts/mcp-smoke.mjs
 * Exit 0 = all six steps passed; non-zero = failure, with the verbatim
 * failing response printed. Requires devDependencies (tsx) — run via
 * `pnpm exec node scripts/mcp-smoke.mjs` from the repo root.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const FIXTURE = join(process.cwd(), "test/server/mcp-server-fixture.ts");
const RESULTS = [];

class McpStdioClient {
  constructor(proc) {
    this.proc = proc;
    this.buf = "";
    this.waiters = new Map();
    this.nextId = 1;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.onData(chunk));
  }
  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined) {
        const w = this.waiters.get(msg.id);
        if (w) { this.waiters.delete(msg.id); w(msg); }
      }
    }
  }
  send(method, params) {
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

function record(step, ok, detail) {
  RESULTS.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}`);
  if (!ok || process.env.VERBOSE) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`);
}

const proc = spawn("node", ["--import", "tsx/esm", FIXTURE], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
const stderr = [];
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => stderr.push(c));

const exit = (code) => {
  try { proc.kill(); } catch {}
  process.exit(code);
};

try {
  const client = new McpStdioClient(proc);

  // 1. initialize
  const init = await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0" },
  });
  const serverName = init?.result?.serverInfo?.name;
  record("initialize handshake", !!serverName, init?.result?.serverInfo ?? init?.error);

  // 2. initialized notification
  client.notify("notifications/initialized");
  await new Promise((r) => setTimeout(r, 150));
  record("notifications/initialized", true, { sent: true });

  // 3. tools/list
  const listed = await client.send("tools/list", {});
  const tools = listed?.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  const canonical = ["graph_query", "graph_path", "graph_tool", "graph_act", "graph_invoke", "graph_explain"];
  const allUnderscore = names.every((n) => /^[a-z0-9_]+$/.test(n));
  record(
    "tools/list (canonical underscore surface)",
    canonical.every((c) => names.includes(c)) && allUnderscore,
    { count: names.length, canonicalPresent: canonical.filter((c) => names.includes(c)).length, allUnderscore },
  );

  // 4. graph_query
  const q = await client.send("tools/call", {
    name: "graph_query",
    arguments: { select: "ax-node", where: { role: "button" } },
  });
  const qText = q?.result?.content?.[0]?.text ?? "";
  let qOk = false;
  try {
    // The query result wraps each node in a {select, node} envelope.
    const parsed = JSON.parse(qText);
    qOk = parsed.hits?.length === 1 && parsed.hits[0]?.node?.name === "Sign up";
  } catch {}
  record("tools/call graph_query {role:button}", qOk, qText.slice(0, 300) || q?.error);

  // 5. graph_path
  const p = await client.send("tools/call", {
    name: "graph_path",
    arguments: { from: "ax:root", relation: "children" },
  });
  const pText = p?.result?.content?.[0]?.text ?? "";
  let pOk = false;
  try { pOk = Array.isArray(JSON.parse(pText).nodes ?? JSON.parse(pText).hits ?? JSON.parse(pText)); } catch {}
  record("tools/call graph_path {from:ax:root, relation:children}", pOk, pText.slice(0, 300) || p?.error);

  // 6. graph_explain
  const e = await client.send("tools/call", { name: "graph_explain", arguments: {} });
  const eText = e?.result?.content?.[0]?.text ?? "";
  record("tools/call graph_explain", !!eText && !e?.error, eText.slice(0, 300) || e?.error);

  const failed = RESULTS.filter((r) => !r.ok).length;
  console.log(`\nMCP smoke: ${RESULTS.length - failed}/${RESULTS.length} steps passed`);
  if (stderr.length) console.log(`server stderr (tail): ${stderr.join("").slice(-200)}`);
  exit(failed ? 1 : 0);
} catch (err) {
  console.error("SMOKE CRASHED:", err);
  console.error("server stderr:", stderr.join("").slice(-2000));
  exit(2);
}
