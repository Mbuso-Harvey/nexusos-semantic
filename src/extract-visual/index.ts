/**
 * extract-visual package — Stage 6.
 *
 * The visual-layer extractor captures rects, computed styles, design-token
 * references, and the tether layout relations for every element matching
 * the visual selector list. See `visual.ts` for the implementation and
 * plan section 6 for the spec.
 */
export {
  visualExtractor,
  VISUAL_PROVENANCE,
  VISUAL_WALKER_FN,
  TOKEN_WALKER_FN,
  CSS_PROPERTIES,
  computeTethers,
  matchTokenRefs,
  kebabToDtcg,
  rgbToHex,
  guessDtcgType,
} from "./visual.js";
export type { VisualElementRaw, VisualWalkResult } from "./visual.js";

export { interpretPage, ALIGN_TOLERANCE_PX, CENTRE_TOLERANCE_PX } from "./interpret.js";
export type { LayoutRelationEdge } from "./interpret.js";

export {
  computeRectIntersection,
  computeRectArea,
  subtractRect,
  computeUnoccludedArea,
  computeAncestorClipping,
  computeNodeOcclusion,
  computePageOcclusion,
  isCandidateAbove,
  canOcclude,
} from "./occlusion.js";

export {
  MAX_SPATIAL_DISTANCE_PX,
  MIN_OVERLAP_PX,
  CONTAINMENT_TOLERANCE_PX,
  computeSegmentOverlap,
  detectSpatialRelations,
  extractSpatialEdges,
} from "./spatial.js";
export type { DetectedSpatialRelation } from "./spatial.js";

export {
  classifyNodeVisualPatterns,
  classifyPageVisualPatterns,
  classifyLayoutMutation,
  computePageLayoutMutations,
} from "./patterns.js";

export {
  parseCssColor,
  colorDistanceRgb,
  parseDimensionPx,
  bindTokensToNode,
  detectTokenDrifts,
  exportDtcgBundle,
  normalizeTokenEntries,
} from "./tokens.js";
export type { TokenDriftLintOptions, ParsedRgba } from "./tokens.js";

export {
  diffVisualNodes,
  diffPageVisualRegression,
  maxSeverity,
} from "./regression.js";
export type { VisualRegressionOptions } from "./regression.js";



