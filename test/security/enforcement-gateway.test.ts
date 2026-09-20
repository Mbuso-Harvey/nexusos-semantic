/**
 * Enforcement subsystem tests (§10–§12).
 *
 * These lock in the fail-closed invariants:
 *   §10 — unknown/unclassified operations are denied, never executed.
 *   §10 — every registered MCP tool has a classification (coverage guard).
 *   §11 — attempts, decisions and denials are audited; a durable-audit failure
 *         fails closed for non-read operations.
 *   §12 — posture/authorization/audit are bound into the execution path for
 *         every transport (MCP tool wrapper + TCP dispatch).
 */
import { describe, it, expect } from "vitest";
import {
  DenialKind,
  EnforcementGateway,
  OperationClassification,
  SecurityPosture,
  configureEnforcement,
  createManifest,
} from "../../src/security/index.js";
import type { AuditStream } from "../../src/security/index.js";
import { Graph } from "../../src/graph/graph.js";
import { buildMcpServer } from "../../src/server/mcp-server.js";
import { GraphServer } from "../../src/server/server.js";

/** Minimal in-memory audit sink used to observe §11 event recording. */
function recordingStream(): { stream: AuditStream; events: unknown[] } {
  const events: unknown[] = [];
  const stream = {
    record: async (event: unknown) => {
      events.push(event);
      return event;
    },
  } as unknown as AuditStream;
  return { stream, events };
}

/** An AUTOPILOT authorization scoped to a set of targets/operations. */
async function authorizedGateway(opts: {
  targets?: string[];
  operations?: string[];
  maxImpact?: "read" | "modify" | "destroy" | "exfiltrate";
  substrates?: Array<"web" | "desktop" | "mobile" | "terminal" | "network" | "system">;
} = {}): Promise<EnforcementGateway> {
  const gateway = new EnforcementGateway();
  await configureEnforcement(
    {
      posture: SecurityPosture.AUTOPILOT,
      targets: opts.targets ?? ["*"],
      operations: opts.operations ?? ["*"],
      substrates: opts.substrates ?? ["web", "desktop", "mobile", "terminal", "network", "system"],
      maxImpact: opts.maxImpact ?? "modify",
      requireDurableAudit: false,
      actor: { id: "test-operator", name: "Test Operator", type: "operator" },
    },
    gateway,
  );
  return gateway;
}

describe("EnforcementGateway — fail-closed classification (§10)", () => {
  it("denies an unclassified operation and never executes it", async () => {
    const gateway = new EnforcementGateway();
    let ran = false;
    const res = await gateway.request(
      { operation: "brand_new_tool", target: "https://app.example.com" },
      () => {
        ran = true;
        return "should not run";
      },
    );

    expect(res.allowed).toBe(false);
    expect(res.denialKind).toBe(DenialKind.UNKNOWN_OPERATION);
    expect(res.reason).toMatch(/fail-closed/);
    expect(res.result).toBeUndefined();
    expect(ran).toBe(false);
    expect(gateway.getAttempts()).toHaveLength(1);
    expect(gateway.getAttempts()[0]!.allowed).toBe(false);
  });

  it("classifies read surfaces and denies write surfaces in the default AUDIT posture", async () => {
    const gateway = new EnforcementGateway();

    const read = await gateway.check({ tool: "graph_query", target: "page:/" });
    expect(read.allowed).toBe(true);
    expect(read.attempt.classification).toBe(OperationClassification.READ);

    const write = await gateway.check({ tool: "chrome_navigate" });
    expect(write.allowed).toBe(false);
    expect(write.denialKind).toBe(DenialKind.POSTURE_DENIED);
    expect(write.reason).toMatch(/AUDIT posture allows only read/);
  });

  it("denies technique/kinetic surfaces in the default AUDIT posture", async () => {
    const gateway = new EnforcementGateway();
    for (const tool of ["graph_invoke", "crawl", "desktop_kinetic_action", "mobile_touch_action", "chrome_launch"]) {
      const res = await gateway.check({ tool, target: "https://app.example.com" });
      expect(res.allowed, tool).toBe(false);
      expect(res.denialKind, tool).toBe(DenialKind.POSTURE_DENIED);
    }
  });
});

describe("EnforcementGateway — auditing (§11)", () => {
  it("records allowed attempts and denials on the audit stream", async () => {
    const gateway = new EnforcementGateway();
    // §12: bind an engagement manifest so every event carries its hash.
    gateway.setManifest(
      createManifest({
        graphHash: "sha256:test-graph",
        posture: SecurityPosture.AUDIT,
        operator: "test-operator",
      }),
    );
    const { stream, events } = recordingStream();
    gateway.setAuditStream(stream);

    await gateway.check({ tool: "graph_query", target: "page:/" });
    await gateway.check({ tool: "crawl", target: "https://app.example.com" });

    expect(events).toHaveLength(2);
    const [allowed, denied] = events as Array<{ success: boolean; operation: string; actor?: string }>;
    expect(allowed!.success).toBe(true);
    expect(allowed!.operation).toBe("graph_query");
    expect(denied!.success).toBe(false);
    expect(denied!.operation).toBe("crawl");
    // §12: every event is bound to the engagement manifest hash.
    expect((events[0] as { manifestHash?: string }).manifestHash).toBeTruthy();
  });

  it("fails closed for non-read operations when the audit write fails", async () => {
    const gateway = await authorizedGateway();
    gateway.setAuditStream({
      record: async () => {
        throw new Error("disk full");
      },
    } as unknown as AuditStream);

    let ran = false;
    const write = await gateway.request({ tool: "crawl", target: "https://app.example.com" }, () => {
      ran = true;
      return "executed";
    });
    expect(ran).toBe(false);
    expect(write.allowed).toBe(false);
    expect(write.denialKind).toBe(DenialKind.SYSTEM);
    expect(write.reason).toMatch(/Durable audit write failed/);

    // Reads still run when requireDurableAudit is false...
    const read = await gateway.check({ tool: "graph_query", target: "page:/" });
    expect(read.allowed).toBe(true);

    // ...but everything fails closed when durable audit is required.
    gateway.setRequireDurableAudit(true);
    const strictRead = await gateway.check({ tool: "graph_query", target: "page:/" });
    expect(strictRead.allowed).toBe(false);
    expect(strictRead.denialKind).toBe(DenialKind.SYSTEM);
  });
});

describe("EnforcementGateway — authorization scope (§12)", () => {
  it("executes an authorized write and records the execution", async () => {
    const gateway = await authorizedGateway({ targets: ["https://app.example.com"] });
    const res = await gateway.request(
      { tool: "crawl", target: "https://app.example.com", impact: "modify" },
      () => "crawled",
    );
    expect(res.allowed).toBe(true);
    expect(res.result).toBe("crawled");
    expect(res.attempt.authorizationId).toBeTruthy();
  });

  it("denies an out-of-scope target even when authorized for another target", async () => {
    const gateway = await authorizedGateway({ targets: ["https://app.example.com"] });
    let ran = false;
    const res = await gateway.request(
      { tool: "crawl", target: "https://evil.example.net", impact: "modify" },
      () => {
        ran = true;
        return "crawled";
      },
    );
    expect(ran).toBe(false);
    expect(res.allowed).toBe(false);
    expect(res.denialKind).toBe(DenialKind.POSTURE_DENIED);
    expect(res.reason).toMatch(/not in authorized scope/);
  });

  it("denies an operation outside the authorized operation list", async () => {
    const gateway = await authorizedGateway({ operations: ["graph_query"] });
    const res = await gateway.check({ tool: "crawl", target: "https://app.example.com", impact: "modify" });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/not in authorized scope/);
  });

  it("requires an explicit sensitive-cookie grant", async () => {
    const gateway = await authorizedGateway({ maxImpact: "exfiltrate" });
    const req = {
      tool: "chrome_get_cookies",
      target: "https://app.example.com",
      impact: "exfiltrate" as const,
      sensitiveCookie: { origin: "https://app.example.com", cookieName: "session" },
    };

    const denied = await gateway.check(req);
    expect(denied.allowed).toBe(false);
    expect(denied.denialKind).toBe(DenialKind.COOKIE_GRANT_DENIED);

    gateway.issueCookieGrant("https://app.example.com", "session*", "test-operator");
    const allowed = await gateway.check(req);
    expect(allowed.allowed).toBe(true);
  });
});

describe("§10 transport coverage — every MCP tool is classified", () => {
  it("classifies every registered MCP tool", () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { desktop: true, mobile: true, chrome: true });
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(tools.length).toBeGreaterThan(20);

    const gateway = new EnforcementGateway();
    const registry = gateway.getRegistry();
    const unclassified = tools.filter((name) => registry.operationFor({ tool: name }) === undefined);
    expect(unclassified).toEqual([]);
  });

  it("denies a kinetic desktop tool without running its handler (fail closed)", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { desktop: true });
    const tool = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;
    })._registeredTools.desktop_kinetic_action;
    expect(tool).toBeDefined();

    const res = await tool!.handler({ target: { titlePattern: "X" }, action: { type: "click" } });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.denied).toBe(true);
    expect(payload.operation).toBe("desktop_act");
  });

  it("allows a desktop read tool in the default AUDIT posture", async () => {
    const graph = new Graph();
    const server = buildMcpServer(graph, { desktop: true });
    const tool = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;
    })._registeredTools.desktop_list_windows;
    expect(tool).toBeDefined();

    // The daemon call itself fails on substrate-less hosts — the handler
    // returns a plain-text tool error ("desktop_list_windows failed: ...",
    // mcp-server.ts), never a structured denial envelope. The *enforcement*
    // decision must be an allow: parse the payload only when the content is
    // JSON, and require no denial envelope in either case.
    const res = await tool!.handler({});
    const trimmed = res.content?.[0]?.text?.trimStart() ?? "";
    const payload = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(trimmed) : {};
    expect(payload.denied).toBeUndefined();
  });
});

describe("§10 transport coverage — TCP/JSON-RPC dispatch is gated", () => {
  it("allows reads and denies a target-scoped mismatch", async () => {
    const graph = new Graph();
    const gateway = await authorizedGateway({ targets: ["https://app.example.com"] });
    const server = new GraphServer(graph, null, gateway);

    const allowed = await server.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "graph.query",
      params: { select: "ax-node", where: { pageUrl: "https://app.example.com/" } },
    });
    expect(allowed.error).toBeUndefined();

    const denied = await server.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "graph.query",
      params: { select: "ax-node", where: {} },
    });
    expect(denied.error).toBeDefined();
    expect(denied.error!.message).toMatch(/enforcement denied/);
    expect(denied.error!.data.denialKind).toBe(DenialKind.POSTURE_DENIED);
  });

  it("leaves unknown methods to the dispatcher (still nothing executes)", async () => {
    const graph = new Graph();
    const server = new GraphServer(graph, null, new EnforcementGateway());
    const res = await server.dispatch({ jsonrpc: "2.0", id: 1, method: "graph.delete_everything", params: {} });
    expect(res.error!.code).toBe(-32601);
    expect(res.error!.message).toMatch(/unknown method/);
  });
});

describe("R3 — fail-closed bootstrap + hardened target scope", () => {
  it("refuses to boot a side-effecting posture on wildcard/implicit targets", async () => {
    const { configureEnforcementFromEnv } = await import("../../src/security/index.js");
    // AWG_POSTURE set, AWG_AUTHORIZED_TARGETS unset → historical default ["*"].
    await expect(
      configureEnforcementFromEnv({ AWG_POSTURE: "autopilot" }, new EnforcementGateway()),
    ).rejects.toThrow(/authorize-targets|wildcard/i);

    // Explicit wildcard → also refused.
    await expect(
      configureEnforcementFromEnv(
        { AWG_POSTURE: "autopilot", AWG_AUTHORIZED_TARGETS: "*" },
        new EnforcementGateway(),
      ),
    ).rejects.toThrow(/wildcard/i);
  });

  it("allows AUDIT with wildcard targets, and a side-effecting posture with explicit targets", async () => {
    const { configureEnforcementFromEnv } = await import("../../src/security/index.js");
    await expect(
      configureEnforcementFromEnv({ AWG_POSTURE: "autopilot" }, new EnforcementGateway()),
    ).rejects.toThrow();
    const readGate = await configureEnforcementFromEnv(
      { AWG_POSTURE: "audit", AWG_AUTHORIZED_TARGETS: "*" },
      new EnforcementGateway(),
    );
    const read = await readGate.check({ tool: "graph_query", target: "https://anything.example/" });
    expect(read.allowed).toBe(true);

    const writeGate = await configureEnforcementFromEnv(
      { AWG_POSTURE: "autopilot", AWG_AUTHORIZED_TARGETS: "app.example.com", AWG_MAX_IMPACT: "modify" },
      new EnforcementGateway(),
    );
    const inScope = await writeGate.check({ tool: "crawl", target: "https://app.example.com/", impact: "modify" });
    expect(inScope.allowed).toBe(true);
  });

  it("binds the engagement manifest to the verified substrate hash (rebindGraphHash)", async () => {
    const gateway = await authorizedGateway({ targets: ["https://app.example.com"] });
    const before = gateway.getManifest()!;
    expect(before.manifest.graphHash).toBe("sha256:unbound-graph");

    const verified = "cafe".repeat(16);
    gateway.rebindGraphHash(verified);
    const after = gateway.getManifest()!;
    expect(after.manifest.graphHash).toBe(verified);
    expect(after.manifestHash).not.toBe(before.manifestHash); // snapshot re-hashed
    expect(after.manifest.revision).toBeGreaterThan(before.manifest.revision);
    // Every subsequent attempt/audit carries the verified hash via the manifest.
    await gateway.check({ tool: "graph_query", target: "https://app.example.com/" });
    expect(gateway.getPostureManager().getManifestHash()).toBe(after.manifestHash);
  });
});