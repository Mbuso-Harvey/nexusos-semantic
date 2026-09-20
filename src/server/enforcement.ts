/** @module server/enforcement
 * Transport-level enforcement adapters (§10–§12).
 *
 * Every external transport funnels through one of the adapters below, so
 * enforcement is an invariant rather than a per-tool check:
 *
 *   - `withToolEnforcement(server)` wraps every MCP tool registration.
 *   - `guardRpcRequest(...)` guards every TCP/JSON-RPC method dispatch.
 *   - `enforceToolExecution(...)` is the shared decision + execute helper.
 *
 * Fail-closed rules:
 *   - A tool/method that has no registered classification is denied.
 *   - Capability execution (`invoke_capability`) is *delegated* to the executor
 *     below MCP (`src/server/invoke.ts`), which is where the side effect is
 *     actually produced. This keeps the MCP layer a transport, not a boundary.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getEnforcementGateway,
  type EnforcementActor,
  type EnforcementGateway,
  type GatewayRequest,
  type GatewayResult,
  type ImpactLevel,
  type OperationKind,
  type RegisteredOperation,
  type SubstrateType,
} from "../security/index.js";

/**
 * Operations enforced *below* the transport layer. `invoke_capability` is the
 * execute path: `src/server/invoke.ts` performs the gate immediately before the
 * kinetic action, so the transport must not pre-empt (or duplicate) it.
 */
const DELEGATED_OPS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  "invoke_capability",
]);

/** Arguments that may carry a target for scope checks, most specific first. */
const TARGET_KEYS = [
  "pageUrl",
  "url",
  "canonicalUrl",
  "pageId",
  "capabilityId",
  "axId",
  "target",
  "deviceId",
  "serial",
  "windowId",
  "titlePattern",
  "title",
  "selector",
  "id",
  "method",
] as const;

/** Nested containers that may hold the target (query predicates, action args). */
const TARGET_CONTAINER_KEYS = ["where", "input", "args", "target"] as const;

function firstStringValue(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === "string" && v.length > 0);
      if (typeof first === "string") return first;
    }
  }
  return undefined;
}

export interface EnforcementAdapterOptions {
  /** Gateway to use. Defaults to the process-wide fail-closed gateway. */
  gateway?: EnforcementGateway;
  /** Actor recorded on attempts/audit events for this transport. */
  actor?: EnforcementActor;
}

/** Build the actor recorded for a transport. */
export function enforcementActor(
  overrides: Partial<EnforcementActor> = {},
): EnforcementActor {
  return {
    id: overrides.id ?? "agent-default",
    name: overrides.name ?? "Default Agent",
    type: overrides.type ?? "agent",
    ...(overrides.publicKey ? { publicKey: overrides.publicKey } : {}),
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  };
}

/**
 * Best-effort target extraction for posture scope checks.
 *
 * Transport tools are mostly target-less graph reads; when a caller does supply
 * a page URL / capability / device id we use it so scoped authorizations can
 * match. When nothing is available we fall back to the tool name, which means a
 * target-scoped authorization will not match and the call is denied
 * (fail-closed) rather than silently allowed.
 */
export function deriveTargetFromArgs(args: unknown, fallback: string): string {
  if (!args || typeof args !== "object") return fallback;
  const record = args as Record<string, unknown>;

  const direct = firstStringValue(record, TARGET_KEYS);
  if (direct) return direct;

  // Query predicates / action args nest the target one level down
  // (e.g. `graph.query` -> `{ where: { pageUrl } }`).
  for (const key of TARGET_CONTAINER_KEYS) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const found = firstStringValue(nested as Record<string, unknown>, TARGET_KEYS);
      if (found) return found;
    }
  }

  return fallback;
}

/** Build the enforcement request for a transport surface (tool or RPC method). */
export function enforcementRequestFor(
  gateway: EnforcementGateway,
  descriptor: { tool?: string; method?: string },
  args: unknown,
): { request: GatewayRequest; operation: RegisteredOperation | undefined } {
  const label = descriptor.tool ?? descriptor.method ?? "unspecified";
  const opKind = gateway.getRegistry().operationFor(descriptor);
  const operation = opKind ? gateway.getRegistry().find(opKind) : undefined;
  const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const impact = typeof record.impact === "string" ? (record.impact as ImpactLevel) : undefined;

  const request: GatewayRequest = {
    ...descriptor,
    target: deriveTargetFromArgs(args, label),
    ...(operation ? { substrate: operation.substrates[0] as SubstrateType } : {}),
    ...(impact ? { impact } : {}),
    params: record,
    confirm: record.confirm === true,
    details: `transport request: ${label}`,
  };

  return { request, operation };
}

/**
 * Decide + execute one transport call through the gateway.
 *
 * The callback runs only when the gateway allows the operation, so the
 * side-effecting body is unreachable on a denial.
 */
export async function enforceToolExecution<T>(
  gateway: EnforcementGateway,
  descriptor: { tool?: string; method?: string },
  args: unknown,
  execute: () => Promise<T> | T,
  options: EnforcementAdapterOptions = {},
): Promise<GatewayResult<T>> {
  const { request } = enforcementRequestFor(gateway, descriptor, args);
  const actor = options.actor ? { actor: options.actor } : {};
  return gateway.request<T>({ ...request, ...actor }, execute);
}

/** True when the transport surface is enforced below the transport. */
export function isDelegatedSurface(
  gateway: EnforcementGateway,
  descriptor: { tool?: string; method?: string },
): boolean {
  const opKind = gateway.getRegistry().operationFor(descriptor);
  return opKind !== undefined && DELEGATED_OPS.has(opKind);
}

/** MCP tool error envelope for a gateway denial (never executes). */
export function toolDenialResponse(result: GatewayResult<unknown>): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          denied: true,
          denialKind: result.denialKind ?? null,
          reason: result.reason,
          attemptId: result.attempt.attemptId,
          operation: result.attempt.operation,
          impact: result.attempt.impact,
        }),
      },
    ],
    isError: true as const,
  };
}

/**
 * Patch `server.registerTool` so every MCP tool call is classified and enforced
 * before its handler runs. Call this immediately after constructing the MCP
 * server, before any tool is registered.
 */
export function withToolEnforcement(
  server: McpServer,
  options: EnforcementAdapterOptions = {},
): EnforcementGateway {
  const gateway = options.gateway ?? getEnforcementGateway();
  const actor = options.actor;

  type ToolHandler = (args: unknown, extra?: unknown) => unknown;
  type RegisterTool = (name: string, config: unknown, handler: ToolHandler) => unknown;

  const target = server as unknown as { registerTool: RegisterTool };
  const original = target.registerTool.bind(server);

  target.registerTool = (name, config, handler) =>
    original(name, config, async (args: unknown, extra?: unknown) => {
      // Capability execution is enforced inside the executor, below MCP.
      if (isDelegatedSurface(gateway, { tool: name })) {
        return handler(args, extra);
      }
      const result = await enforceToolExecution(
        gateway,
        { tool: name },
        args,
        () => handler(args, extra),
        actor ? { actor } : {},
      );
      if (!result.allowed) return toolDenialResponse(result);
      if (result.error !== undefined) throw result.error;
      return result.result;
    });

  return gateway;
}

/** RPC error code used for enforcement denials (JSON-RPC server error range). */
export const ENFORCEMENT_DENIED_CODE = -32003;

/**
 * Guard one TCP/JSON-RPC method dispatch.
 *
 * Returns `null` when the method is not a classified surface (the dispatcher's
 * own switch handles unknown methods and returns an error — nothing executes),
 * or when the surface is delegated to a deeper layer. Otherwise it returns the
 * gateway decision; callers must refuse to run the method when `allowed` is
 * false.
 */
export async function guardRpcRequest(
  gateway: EnforcementGateway,
  method: string,
  params: unknown,
  options: EnforcementAdapterOptions = {},
): Promise<GatewayResult<never> | null> {
  const descriptor = { method };
  const opKind = gateway.getRegistry().operationFor(descriptor);
  if (!opKind) return null;
  if (DELEGATED_OPS.has(opKind)) return null;

  const { request } = enforcementRequestFor(gateway, descriptor, params);
  const actor = options.actor ? { actor: options.actor } : {};
  return gateway.request<never>({ ...request, ...actor, execute: false });
}