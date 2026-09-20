/**
 * extract-structure package — Stage 5.
 *
 * The structural extractor walks a page's accessibility tree (via an
 * in-page JS walker sent through BiDi `script.callFunction`) and writes
 * `AxNode` records plus the aria-/declarative-relation edges into the
 * graph. See `structural.ts` for the implementation.
 */
export {
  structuralExtractor,
  STRUCTURE_PROVENANCE,
  WALKER_FN,
  EXTRACT_EDGES_FN,
} from "./structural.js";
export type { AxTreeNode, WalkResult } from "./structural.js";
