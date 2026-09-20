/**
 * CLI re-exports — the `awg` entry script lives at `cli/awg.ts`; this index
 * just makes the module addressable from tests and other entry points.
 */
export { buildMcpServer, startMcpServer, GraphServer, GraphClient } from "../server/index.js";
export { Crawler, DEFAULT_BUDGET } from "../crawler/orchestrator.js";
export { Graph } from "../graph/graph.js";
export { GraphStore } from "../store/store.js";
