/**
 * Naming + dispatch drift lock (ED-10 §5 — Option B, binding).
 *
 * Standardization decision: the registered MCP tool name (underscore style)
 * is THE canonical public name; dotted forms are internal v1 JSON-RPC aliases
 * on the TCP dispatcher. Two invariants are locked here:
 *
 * 1. **Naming convention**: every registered MCP tool name matches
 *    `^[a-z0-9_]+$` — no dots in MCP tool names. A dotted tool name is
 *    unconventional in the MCP ecosystem and risks client-side rejection.
 *
 * 2. **Dispatchability**: every registered MCP tool name must be dispatchable
 *    by the TCP/JSON-RPC dispatcher (its name appears as a `case` label in
 *    `src/server/server.ts`). The 2026-09-16 Evidence Ledger capability
 *    battery found the original defect this way: `graph_query` was registered
 *    but the dispatcher accepted only the dotted `graph.query`, so a client
 *    calling the documented, registered tool name got "unknown method"
 *    (-32601). The lock compares the tools/list contract against the
 *    dispatcher's case labels by scanning the source — it never EXECUTES
 *    tool calls, so side-effect tools (chrome_launch, crawl_start, ...) are
 *    safe to lock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

function makeServerEntry() {
  const entry = join(process.cwd(), "test/server/mcp-server-fixture.ts");
  return spawn("node", ["--import", "tsx/esm", entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
}

interface JsonRpcMsg { jsonrpc: "2.0"; id?: number | string; method?: string; result?: any; error?: any; params?: any; }

class McpStdioClient {
  private buf = "";
  private waiters = new Map<number, (msg: JsonRpcMsg) => void>();
  private nextId = 1;
  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
  }
  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMsg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined) {
        const w = this.waiters.get(msg.id as number);
        if (w) { this.waiters.delete(msg.id as number); w(msg); }
      }
    }
  }
  send(method: string, params?: any): Promise<JsonRpcMsg> {
    const id = this.nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(JSON.stringify(req) + "\n");
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }
  close() {
    this.proc.kill();
  }
}

describe("Tool naming + dispatch drift lock (ED-10 §5)", () => {
  let proc: ChildProcessWithoutNullStreams;
  let client: McpStdioClient;
  let toolNames: string[] = [];

  beforeAll(async () => {
    proc = makeServerEntry();
    client = new McpStdioClient(proc);
    proc.stderr.on("data", () => undefined);
    const init = await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0" },
    });
    expect(init.result).toBeDefined();
    const res = await client.send("tools/list", {});
    if (!res.result || !res.result.tools) {
      throw new Error("tools/list returned no tools. full result: " + JSON.stringify(res));
    }
    toolNames = res.result.tools.map((t: any) => t.name);
  }, 30_000);

  afterAll(() => {
    client.close();
  });

  it("registers exactly the 18-tool default surface (claim-drift lock)", () => {
    // Claim drift found 2026-09-17: the docs claimed "30 MCP tools" while the
    // DEFAULT surface (no opt-ins) is 18 — 6 core (query, path, tool, act,
    // invoke, explain) + substrate_info + graph_diagnostics + 10 visual/token
    // tools. Opt-in substrates add desktop (+3), chrome/CDP (+6), mobile (+3),
    // and crawl jobs (+3), for a maximum of 33. Locking the exact default
    // count means any silent tool loss OR addition fails here and forces the
    // docs and this lock to be updated together.
    expect(toolNames.length).toBe(18);
  });

  it("every registered tool name matches ^[a-z0-9_]+$ (underscore canonical, no dots)", () => {
    const offenders = toolNames.filter((n) => !/^[a-z0-9_]+$/.test(n));
    expect(offenders).toEqual([]);
  });

  it("every registered tool name is dispatchable by the TCP dispatcher (case label present)", () => {
    // Source-scan of the dispatcher's switch cases — no tool calls executed.
    const serverSrc = readFileSync(join(process.cwd(), "src", "server", "server.ts"), "utf8");
    const caseLabels = new Set<string>();
    for (const m of serverSrc.matchAll(/case\s+"([^"]+)"/g)) {
      const label = m[1];
      if (label) caseLabels.add(label);
    }
    const undispatchable = toolNames.filter((n) => !caseLabels.has(n));
    expect(undispatchable).toEqual([]);
  });
});
