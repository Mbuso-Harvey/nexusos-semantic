/**
 * crawler package — orchestrator, default extractors, and re-exports.
 */
export { Crawler, DEFAULT_EXTRACTORS, DEFAULT_BUDGET } from "./orchestrator.js";
export type { CrawlBudget, CrawlOptions, Extractor, ExtractorContext, FrontierEntry } from "./orchestrator.js";
// R5: async crawl jobs — background substrate production with atomic publish.
export { CrawlJobManager, CrawlJobError } from "./jobs.js";
export type {
  CrawlJobHandle,
  CrawlJobProducer,
  CrawlJobState,
  StartCrawlJobOptions,
} from "./jobs.js";
export {
  exportSessionStorageState,
  applySessionStorageState,
  saveAuthStateToFile,
  loadAuthStateFromFile,
} from "./session-auth.js";
export type {
  SessionStorageState,
  SessionCookieState,
  StorageOriginState,
  StorageEntry,
} from "./session-auth.js";
export {
  parseAuthSpec,
  resolveAuthContexts,
  authContextToString,
  applyAuthSpec,
} from "./auth.js";

