/**
 * store package — disk persistence, in-memory rehydration, and the
 * fail-closed substrate gate (R1) + provenance/hash binding (R2).
 */
export { GraphStore, loadFromDocument, hashFrontier, hashPageContent } from "./store.js";
export { SqliteGraphStore } from "./sqlite-store.js";
export type { CrawlMeta } from "./store.js";
export type { SqliteStoreOptions } from "./sqlite-store.js";
export {
  computeGraphHash,
  loadSubstrate,
  assertGraphHashBinding,
  SubstrateLoadError,
} from "./store.js";
export type { SubstrateLoadErrorCode } from "./store.js";
export type { SubstrateProvenance } from "../graph/types.js";


