/**
 * Public surface of the extract-state package.
 *
 *  - Section 7.1: declared half (this stage) — static extraction from HTML.
 *  - Section 7.2: observed half (next stage) — probe loop over interactive
 *    elements that records observed transitions.
 *
 * The orchestrator imports the `extractStateDeclared` Extractor from here
 * (along with its sibling `observedExtractor`) and wires it into the
 * per-page sequence.
 */
export {
  extractStateDeclared,
  buildDeclared,
} from "./declared.js";
export type { DeclaredRecord, DeclaredResult } from "./declared.js";

export {
  observedExtractor,
  runObservedExtractor,
  runObservedProbeLoop,
  listInteractiveElements,
  takeObservedSnapshot,
  snapshotDiffers,
  buildTransitionsForRun,
  LIST_INTERACTIVE_FN,
  TAKE_SNAPSHOT_FN,
  MAX_PROBES,
  PROBE_TIMEOUT_MS,
  POST_ACTION_SETTLE_MS,
  __resetTransitionCounterForTests,
} from "./observed.js";
export type {
  InteractiveElement,
  ObservedSnapshot,
  ObservedRect,
  ObservedPageLike,
  ObservedProbeOptions,
  ObservedProbeResult,
  ObservedTransitionHit,
} from "./observed.js";

export {
  materializeState,
  materializeSuccessor,
  materializeCausalAuthTransition,
} from "./state-materialize.js";
export type {
  MaterializeSnapshot,
  MaterializeResult,
  MaterializeSuccessorOptions,
} from "./state-materialize.js";
