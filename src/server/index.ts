/**
 * server package — MCP-shaped graph methods over two transports:
 *   - `mcp-server.ts`  — official MCP stdio transport (the public face;
 *                        real MCP clients speak this directly)
 *   - `server.ts`      — local TCP JSON-RPC 2.0 (kept for in-process tests
 *                        and ad-hoc scripting; the method surface is identical)
 *
 * ED-02 / PR-9: `invoke.ts` is the execute-path surface. The server
 * owns the BiDi session for the lifetime of the MCP connection.
 */
export { GraphServer, GraphClient } from "./server.js";
export type { RpcRequest, RpcResponse, BidiContext, ActContext } from "./server.js";
export { buildMcpServer, startMcpServer } from "./mcp-server.js";
export type { McpServerOptions } from "./mcp-server.js";
export { invokeCapability } from "./invoke.js";
export type { InvokeRequest, InvokeResult, ObserveOk, ObserveErr } from "./invoke.js";
export {
  withToolEnforcement,
  guardRpcRequest,
  enforceToolExecution,
  enforcementRequestFor,
  enforcementActor,
  deriveTargetFromArgs,
  isDelegatedSurface,
  toolDenialResponse,
  ENFORCEMENT_DENIED_CODE,
} from "./enforcement.js";
export type { EnforcementAdapterOptions } from "./enforcement.js";
