/**
 * Server — plan section 9 + section 12 (security tiers).
 *
 * v1 transport: line-delimited JSON over a local TCP socket. Each line is one
 * JSON-RPC 2.0 request OR response. The server keeps a single shared `Graph`
 * (loaded from disk at startup, or injected for tests) and routes MCP-shaped
 * method names to the graph query layer + capability action layer.
 *
 * Methods exposed (plan section 9.1):
 *   graph.query     — find nodes by where-clause
 *   graph.path      — find a path between two ax nodes
 *   graph.tool      — list capabilities
 *   graph.act       — invoke a capability (decision only in v1)
 *   graph.explain   — neighborhood walk + provenance
 *
 * The "MCP-shaped" frame is a strict subset of JSON-RPC 2.0 — we accept
 * `method` + `params` and return `result` or `error`. v2 can swap the
 * transport for stdio + the official MCP SDK without changing the methods.
 */
import { createServer, Socket } from "node:net";
import type { Graph } from "../graph/graph.js";
import type { Page } from "../bidi-client/page.js";
import type { BiDiSession } from "../bidi-client/session.js";
import { query, type QueryRequest } from "../graph/query.js";
import { findPath, listTools, prepareAct, explain } from "../graph/tools.js";
import { diffPageVisualRegression } from "../extract-visual/index.js";
import { invokeCapability, type InvokeRequest, type InvokeResult } from "./invoke.js";
import { getEnforcementGateway, type EnforcementGateway } from "../security/index.js";
import { ENFORCEMENT_DENIED_CODE, enforcementActor, guardRpcRequest } from "./enforcement.js";
import { NEXUS_VERSION } from "../version.js";

export type RpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
};

export type RpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

// ---- Capability execution layer (ED-02 / PR-9) ----
// Per ED-02 the server owns the BiDi session for the lifetime of
// the MCP connection. The constructor accepts an optional
// `BidiContext` (BiDiSession + a long-lived Page). When present,
// the new `graph.invoke` dispatch case routes through
// `invokeCapability` (see ./invoke.ts), which performs the
// security gate then executes the action. When absent, `graph.invoke`
// returns a clear "no BiDi session attached" error. `graph.act`
// stays decision-only — it is the v1 backward-compat alias.

export interface BidiContext {
  session: BiDiSession;
  page: Page;
}

/** Deprecated alias for `BidiContext`. Kept so existing callers
 *  that passed `{ page }` keep compiling. The single `page`
 *  field is the only one the v1 server consulted. */
export type ActContext = BidiContext;

export class GraphServer {
  private sockets = new Set<Socket>();
  private server: import("node:net").Server | null = null;
  /** §10–§12: every dispatch is classified + gated by this gateway. */
  private gateway: EnforcementGateway;

  constructor(
    private graph: Graph,
    private bidi: BidiContext | null = null,
    gateway: EnforcementGateway = getEnforcementGateway(),
  ) {
    this.gateway = gateway;
  }

  start(port: number, host = "127.0.0.1"): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const srv = createServer((sock) => this.handleSocket(sock));
      srv.on("error", reject);
      srv.listen(port, host, () => {
        this.server = srv;
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          resolve({ host: addr.address, port: addr.port });
        } else {
          resolve({ host, port });
        }
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const s of this.sockets) s.destroy();
      this.sockets.clear();
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  private handleSocket(sock: Socket) {
    this.sockets.add(sock);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        this.handleLine(sock, line);
      }
    });
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => this.sockets.delete(sock));
  }

  private handleLine(sock: Socket, line: string) {
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch (e) {
      this.send(sock, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error", data: String((e as Error).message) } });
      return;
    }
    if (req.jsonrpc !== "2.0" || !req.method) {
      this.send(sock, { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32600, message: "invalid request" } });
      return;
    }
    this.dispatch(req).then((res) => this.send(sock, res));
  }

  private send(sock: Socket, res: RpcResponse) {
    sock.write(JSON.stringify(res) + "\n");
  }

  /** Dispatch a single request — exposed for tests so they don't need a socket. */
  async dispatch(req: RpcRequest): Promise<RpcResponse> {
    const id = req.id ?? null;
    try {
      // §10: the enforcement boundary. Unclassified methods fall through to the
      // switch below (which never executes them); delegated surfaces
      // (`graph.invoke`) are enforced inside the executor, below this transport.
      const denial = await guardRpcRequest(this.gateway, req.method, req.params, {
        actor: enforcementActor({
          id: "graph-server",
          name: "Graph TCP Server",
          type: "system",
        }),
      });
      if (denial && !denial.allowed) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: ENFORCEMENT_DENIED_CODE,
            message: `enforcement denied: ${denial.reason}`,
            data: {
              denialKind: denial.denialKind ?? null,
              attemptId: denial.attempt.attemptId,
              operation: denial.attempt.operation,
              impact: denial.attempt.impact,
            },
          },
        };
      }
      switch (req.method) {
        // ED-10 §5: every registered MCP tool name must be dispatchable.
        // The registry registers the core surface under the underscore names
        // (`graph_query`, `graph_path`, `graph_tool`, `graph_act`,
        // `graph_invoke`, `graph_explain`); the dispatcher previously
        // accepted only the dotted forms, so a client calling the
        // documented, registered tool name over this transport got
        // "unknown method" (-32601) — found by the Evidence Ledger
        // capability battery (2026-09-16). Dual-form dispatch is locked by
        // test/server/server.test.ts.
        case "graph_query":
        case "graph.query": {
          const result = query(this.graph, req.params as QueryRequest);
          return { jsonrpc: "2.0", id, result };
        }
        case "graph_path":
        case "graph.path": {
          const { from, to, via, maxHops } = req.params ?? {};
          if (typeof from !== "string" || typeof to !== "string") {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "from and to are required (axIds)" } };
          }
          const result = findPath(this.graph, from, to, { via, maxHops });
          return { jsonrpc: "2.0", id, result };
        }
        case "graph_tool":
        case "graph.tool": {
          const result = listTools(this.graph, req.params ?? {});
          return { jsonrpc: "2.0", id, result };
        }
        case "graph_act":
        case "graph.act": {
          // ED-02 alias: graph.act is the v1 decision-only surface.
          // It returns the same `ActResult` shape (decision + binding)
          // and does NOT execute the action. SDK callers that want
          // the execute path use `graph.invoke` instead. This keeps
          // backward compat with any pre-PR-9 client.
          const decision = prepareAct(this.graph, req.params ?? {});
          return { jsonrpc: "2.0", id, result: decision };
        }
        case "graph_invoke":
        case "graph.invoke": {
          // ED-02 / PR-9: gate + execute. The server owns the BiDi
          // session via `this.bidi` (set by the CLI on `awg serve`).
          // When `this.bidi` is null, `invokeCapability` returns a
          // clean "no page attached" error rather than hanging.
          const invokeReq: InvokeRequest = {
            capabilityId: req.params?.capabilityId,
            input: req.params?.input ?? {},
            confirm: req.params?.confirm,
            execute: req.params?.execute,
            evidence: req.params?.evidence,
          };
          const result: InvokeResult = await invokeCapability(
            this.graph,
            this.bidi ? this.bidi.page : null,
            invokeReq,
          );
          return { jsonrpc: "2.0", id, result };
        }
        case "graph_explain":
        case "graph.explain": {
          const result = explain(this.graph, req.params ?? { id: "" });
          if (result === null) {
            return { jsonrpc: "2.0", id, error: { code: -32004, message: "id not found" } };
          }
          return { jsonrpc: "2.0", id, result };
        }
        case "substrate_info": {
          // ED-10 §5 drift lock (test/server/naming-drift.test.ts): every name
          // in the default MCP surface must be dispatchable here. The default
          // surface includes substrate_info — the provenance tool the
          // integration guide tells clients to call FIRST. Mirrors the MCP
          // implementation in mcp-server.ts; the TCP surface attaches no
          // desktop/mobile clients, so those report "disabled" truthfully.
          const prov = this.graph.substrateProvenance;
          const result = prov
            ? {
                bound: true,
                outputDir: prov.outputDir,
                graphPath: prov.graphPath,
                graphHash: prov.graphHash,
                rootUrl: prov.crawl?.rootUrl ?? null,
                crawlStartedAt: prov.crawl?.startedAt ?? null,
                crawlFinishedAt: prov.crawl?.finishedAt ?? null,
                browser: prov.crawl?.browser ?? null,
                pages: prov.crawl?.pages ?? this.graph.pageCount,
                tokens: prov.crawl?.tokens ?? this.graph.tokenCount,
                frontierHash: prov.frontierHash,
                buildVersion: prov.buildVersion,
                substrates: {
                  web: this.bidi ? "online (BiDi attached)" : "offline (no BiDi session attached)",
                  desktop: "disabled",
                  mobile: "disabled",
                },
              }
            : {
                bound: false,
                warning:
                  "This server was started with an in-memory graph that has no substrate provenance. Every result is unattributed: there is no recorded rootUrl, crawl time, or content hash. Serve a real substrate directory (`awg serve --graph <dir>`) for attributed results.",
                pages: this.graph.pageCount,
                tokens: this.graph.tokenCount,
                buildVersion: NEXUS_VERSION,
              };
          return { jsonrpc: "2.0", id, result };
        }
        case "graph_diagnostics": {
          // ED-10 §5 drift lock: part of the default MCP surface; mirrors the
          // mcp-server.ts implementation (extraction health + recommendations).
          const diag = typeof this.graph.getDiagnostics === "function"
            ? this.graph.getDiagnostics()
            : { extractorFailures: [], pageErrors: [], extractionWarnings: [] };
          const pages = Array.from(this.graph.pages());
          const loadedPages = pages.filter((p) => p.loadStatus === "complete" || p.loadStatus === "interactive");
          const failedPages = pages.filter((p) => p.loadStatus === "spa-error" || p.loadStatus === "timeout");
          const INTERACTIVE_ROLES = new Set([
            "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
            "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider",
          ]);
          const unlabeled: Array<{ id: string; role: string; pageId: string }> = [];
          for (const node of this.graph.allNodes()) {
            if (node.type === "ax-node") {
              const ax = node as import("../graph/types.js").AxNode;
              if (INTERACTIVE_ROLES.has(ax.role) && (!ax.name || ax.name.trim() === "")) {
                unlabeled.push({ id: ax.id, role: ax.role, pageId: ax.pageId });
              }
            }
          }
          const recommendations: string[] = [];
          if (failedPages.length > 0) recommendations.push(`${failedPages.length} page(s) failed to load or timed out. Check failedPages for error details.`);
          if (diag.extractorFailures.length > 0) recommendations.push(`${diag.extractorFailures.length} extractor exception(s) occurred during crawl. Inspect extractorFailures.`);
          if (diag.extractionWarnings.length > 0) recommendations.push(`${diag.extractionWarnings.length} DOM elements had extraction issues and degraded to presentation fallbacks. Inspect extractionWarnings.`);
          if (unlabeled.length > 0) recommendations.push(`${unlabeled.length} interactive elements lack accessible names. Consider using coordinate clicks or container queries for them.`);
          if (recommendations.length === 0) recommendations.push("Substrate extraction is 100% healthy with zero degraded elements or crawl errors.");
          const result = {
            summary: {
              pagesTotal: pages.length,
              pagesLoaded: loadedPages.length,
              pagesFailed: failedPages.length,
              axNodesTotal: this.graph.axCount,
              capabilitiesTotal: this.graph.capabilityCount,
              statesTotal: this.graph.stateCount,
              healthScorePercent: pages.length > 0 ? Math.round((loadedPages.length / pages.length) * 100) : 100,
            },
            substrates: {
              web: this.bidi ? "online (BiDi attached)" : "offline (no BiDi session attached)",
              desktop: "disabled",
              mobile: "disabled",
            },
            failedPages: failedPages.map((p) => {
              const err = diag.pageErrors.find((e) => e.url === p.url);
              return { url: p.url, status: p.loadStatus, error: err?.error ?? "Unknown page failure" };
            }),
            extractorFailures: diag.extractorFailures,
            extractionWarnings: diag.extractionWarnings,
            unlabeledInteractive: unlabeled.slice(0, 50),
            recommendations,
            substrate: {
              rootUrl: this.graph.substrateProvenance?.crawl?.rootUrl ?? null,
              graphHash: this.graph.substrateProvenance?.graphHash ?? null,
              crawlFinishedAt: this.graph.substrateProvenance?.crawl?.finishedAt ?? null,
              buildVersion: this.graph.substrateProvenance?.buildVersion ?? NEXUS_VERSION,
            },
          };
          return { jsonrpc: "2.0", id, result };
        }
        case "get_visual":
        case "graph.getVisual": {
          const { axId, viewport } = req.params ?? {};
          if (typeof axId !== "string") {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "axId is required" } };
          }
          const result = viewport !== undefined
            ? this.graph.visualByAxAndViewport(axId, viewport)
            : this.graph.visualByAx(axId);
          if (!result) {
            return { jsonrpc: "2.0", id, error: { code: -32004, message: `visual not found for axId: ${axId}` } };
          }
          return { jsonrpc: "2.0", id, result };
        }
        case "query_viewport_diff":
        case "graph.viewportDiff": {
          const { axId, fromViewport, toViewport } = req.params ?? {};
          if (typeof axId !== "string" || fromViewport === undefined || toViewport === undefined) {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "axId, fromViewport, and toViewport are required" } };
          }
          const result = this.graph.queryViewportDiff(axId, fromViewport, toViewport);
          if (!result) {
            return { jsonrpc: "2.0", id, error: { code: -32004, message: `viewport diff not found for axId: ${axId}` } };
          }
          return { jsonrpc: "2.0", id, result };
        }
        case "get_visual_containers":
        case "graph.visualContainers": {
          const { pageId } = req.params ?? {};
          const result = this.graph.visualContainers(pageId);
          return { jsonrpc: "2.0", id, result };
        }
        case "get_spatial_neighbors":
        case "graph.spatialNeighbors": {
          const { visId, direction } = req.params ?? {};
          if (typeof visId !== "string") {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "visId is required" } };
          }
          const result = this.graph.spatialNeighbors(visId, direction);
          return { jsonrpc: "2.0", id, result };
        }
        case "get_occluded_nodes":
        case "graph.occludedNodes": {
          const { pageId, minRatio } = req.params ?? {};
          const result = this.graph.occludedNodes(pageId, minRatio);
          return { jsonrpc: "2.0", id, result };
        }
        case "get_visual_patterns":
        case "graph.visualPatterns": {
          const { pageId, pattern, minConfidence } = req.params ?? {};
          const result = this.graph.visualPatterns(pageId, pattern, minConfidence);
          return { jsonrpc: "2.0", id, result };
        }
        case "query_page_layout_mutations":
        case "graph.pageLayoutMutations": {
          const { pageId, fromViewport, toViewport } = req.params ?? {};
          if (typeof pageId !== "string" || fromViewport === undefined || toViewport === undefined) {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "pageId, fromViewport, and toViewport are required" } };
          }
          const result = this.graph.queryPageLayoutMutations(pageId, fromViewport, toViewport);
          if (!result) {
            return { jsonrpc: "2.0", id, error: { code: -32004, message: `page layout mutations not found for pageId: ${pageId}` } };
          }
          return { jsonrpc: "2.0", id, result };
        }
        case "query_visual_regression":
        case "graph.visualRegression": {
          const { pageId, baselineNodes, candidateNodes, options } = req.params ?? {};
          if (typeof pageId !== "string") {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "pageId is required" } };
          }
          const baseNodes = Array.isArray(baselineNodes) ? baselineNodes : [];
          const candNodes = Array.isArray(candidateNodes) ? candidateNodes : this.graph.visualByPage(pageId);
          const result = diffPageVisualRegression(baseNodes, candNodes, pageId, options);
          return { jsonrpc: "2.0", id, result };
        }
        case "lint_design_tokens":
        case "graph.lintTokens": {
          const { pageId, options } = req.params ?? {};
          const result = this.graph.lintTokenDrift(pageId, options);
          return { jsonrpc: "2.0", id, result };
        }
        case "export_dtcg_tokens":
        case "graph.exportTokens": {
          const result = this.graph.exportDtcgTokens();
          return { jsonrpc: "2.0", id, result };
        }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${req.method}` } };
      }
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "internal error", data: String((e as Error).message) } };
    }
  }
}

/**
 * Client side — minimal line-delimited JSON-RPC 2.0 client for the server.
 * Used by the CLI (Stage 16) and tests.
 */
import { connect, type Socket as TcpSocket } from "node:net";

export class GraphClient {
  private sock: TcpSocket | null = null;
  private buf = "";
  private waiters = new Map<number | string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private nextId = 1;

  constructor(private host: string, private port: number) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock = connect(this.port, this.host);
      this.sock.setEncoding("utf8");
      this.sock.once("error", reject);
      this.sock.once("connect", () => {
        this.sock!.on("data", (chunk: string) => this.onData(chunk));
        this.sock!.on("close", () => this.onClose());
        resolve();
      });
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let res: RpcResponse;
      try { res = JSON.parse(line) as RpcResponse; }
      catch { continue; }
      const w = this.waiters.get(res.id as any);
      if (w) {
        this.waiters.delete(res.id as any);
        if (res.error) w.reject(Object.assign(new Error(res.error.message), { rpc: res }));
        else w.resolve(res.result);
      }
    }
  }

  private onClose() {
    for (const w of this.waiters.values()) w.reject(new Error("connection closed"));
    this.waiters.clear();
  }

  call<T = any>(method: string, params?: any): Promise<T> {
    if (!this.sock) throw new Error("not connected");
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(id, { resolve: resolve as any, reject });
      this.sock!.write(JSON.stringify(req) + "\n");
    });
  }
}
