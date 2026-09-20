/**
 * Agent Web Graph / NexusOS — Universal Accessibility & Kinetic Substrate.
 *
 * Exposes unified cross-substrate automation for Web (BiDi), Native Desktop (UIA/AX),
 * and Mobile (ADB/WDA) surfaces alongside the MCP server and graph store.
 */

// Core graph & query
export * from "./graph/graph.js";
export * from "./graph/query.js";
export * from "./graph/types.js";
export * from "./graph/tools.js";

// Substrate abstractions
export * from "./substrate/index.js";

// Desktop & Mobile native integrations
export * from "./desktop/index.js";
export * from "./mobile/index.js";

// Storage
export * from "./store/index.js";

// MCP server
export * from "./server/index.js";

// Security: posture, authorization, audit, manifest + the enforcement gateway.
// Plan decision §9–§12 — authorization is a core substrate primitive, and the
// gateway is the enforcement boundary that all transports route through.
export * from "./security/index.js";
