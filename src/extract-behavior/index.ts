/**
 * Stage 8: behavior extraction (re-exports).
 */
export {
  extractBehavior,
  runBehaviorExtractor,
  toDeclaredCapability,
  synthesizeCapability,
  buildSelector,
  slugify,
} from "./behavior.js";
export type {
  ElementHint,
  DeclaredCapabilityShape,
  BehaviorExtractorDeps,
  BehaviorExtractorResult,
} from "./behavior.js";
