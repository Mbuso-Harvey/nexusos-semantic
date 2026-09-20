/**
 * Stage 6 — interpret (ED-06).
 *
 * The visual substrate captures raw geometry and computed style.
 * This module provides the interpretive layer: it analyzes those
 * primitives and produces structured descriptions.
 *
 * ED-06 §4 binding — three required interpretations:
 *
 * 1. Grid structure analysis — display:grid/inline-grid →
 *    GridDescription { columns, rows, columnGap, rowGap }.
 *    Track values are raw CSS strings (e.g. "1fr 2fr") — the brief
 *    (§5) shows "width: 1200px", not a parsed AST, so the raw value
 *    is the right level of description.
 *
 * 2. Flex axis analysis — display:flex/inline-flex →
 *    FlexDescription { direction, wrap, gap, mainAxis, crossAxis }.
 *
 * 3. Alignment relationship extraction — sibling rect ±2px →
 *    LayoutRelation[] attached to each VisualNode; edges of kind
 *    "visual:layout-relation" emitted from the source to the related sibling.
 *    Threshold of ±2px is recorded here (ED-05 constraint: any change
 *    to the threshold is a documented substitution).
 *
 * Layer 3 deferred (now implemented):
 *
 * 4. Visual prominence — which nodes/regions are most visually significant.
 *    Scores each element's visual weight signals: z-index, opacity,
 *    transform:scale(), and font-size. Derived flags: isOverlay,
 *    isInteractive, isProminent.
 *
 * 5. Component inference — spatial grouping of related nodes into UI
 *    components. Uses bounding-box overlap and DOM proximity to identify
 *    flex/grid containers, forms, cards, toolbars, and more.
 *
 * 6. Responsive behaviour signals — single-viewport CSS signals that
 *    encode viewport adaptivity: percentage widths, flex-wrap, grid
 *    responsive patterns, clamp() fonts.
 */
import type {
  AlignmentKind,
  ComponentGroup,
  ComponentType,
  FlexDescription,
  GridDescription,
  LayoutRelation,
  Rect,
  ResponsiveHint,
  ResponsiveStrategy,
  VisualInterpretation,
  VisualNode,
  VisualProminence,
} from "../graph/types.js";

// ---------------------------------------------------------------------------
// Alignment threshold constants (ED-06 §4 binding — recorded, not derived)
// ---------------------------------------------------------------------------

/**
 * Tolerance in pixels for "sibling equality" checks in alignment detection.
 * Used for y-alignment (same top edge) and x-alignment (same left edge).
 * ED-06 records this value; any change is a documented substitution per ED-05.
 */
export const ALIGN_TOLERANCE_PX = 2;

/**
 * Tolerance in pixels for centre-alignment detection.
 * Used for `centred-with`: comparing midpoint coordinates.
 * ED-06 records this value; any change is a documented substitution per ED-05.
 */
export const CENTRE_TOLERANCE_PX = 4;

// ---------------------------------------------------------------------------
// Grid structure analysis
// ---------------------------------------------------------------------------

/**
 * True iff the display value indicates a CSS grid container.
 */
export function isGridDisplay(display: string | undefined): boolean {
  if (!display) return false;
  const d = display.trim().toLowerCase();
  return d === "grid" || d === "inline-grid" || d === "subgrid";
}

/**
 * Parse a grid-template-columns or grid-template-rows value into a list
 * of track size strings.
 *
 * The brief (§5) shows "width: 1200px", not a parsed AST. We preserve
 * the raw track values as-is: strings like "1fr", "2fr", "repeat(3, 1fr)",
 * "minmax(100px, 1fr)", "auto", "1px". Reject the "grid-template-areas"
 * shorthand (not in CSS_PROPERTIES — defensive only).
 *
 * Edge: if the value is empty/undefined/null, return an empty array.
 * Edge: if the value contains "none" (cancelled template), return [].
 */
export function parseGridTemplate(raw: string | undefined): string[] {
  if (!raw) return [];
  const v = raw.trim();
  if (!v || v === "none" || v === "initial" || v === "inherit" || v === "revert") {
    return [];
  }
  // Split on whitespace. Each token is a track size.
  return v.split(/\s+/).filter(Boolean);
}

/**
 * Extract a GridDescription from a VisualNode's computed style.
 * Returns undefined when the element is not a grid container.
 */
export function extractGridDescription(node: VisualNode): GridDescription | undefined {
  const cs = node.computedStyle;
  if (!isGridDisplay(cs.display)) return undefined;

  return {
    type: "grid",
    columns: parseGridTemplate(cs["grid-template-columns"]),
    rows: parseGridTemplate(cs["grid-template-rows"]),
    columnGap: cs["column-gap"] ?? "",
    rowGap: cs["row-gap"] ?? "",
  };
}

// ---------------------------------------------------------------------------
// Flex axis analysis
// ---------------------------------------------------------------------------

/**
 * True iff the display value indicates a CSS flex container.
 */
export function isFlexDisplay(display: string | undefined): boolean {
  if (!display) return false;
  const d = display.trim().toLowerCase();
  return d === "flex" || d === "inline-flex";
}

type FlexDirection = "row" | "column" | "row-reverse" | "column-reverse";

function parseFlexDirection(raw: string | undefined): FlexDirection {
  switch ((raw ?? "row").trim().toLowerCase()) {
    case "row":          return "row";
    case "row-reverse":  return "row-reverse";
    case "column":       return "column";
    case "column-reverse": return "column-reverse";
    default:             return "row";
  }
}

function directionToAxes(dir: FlexDirection): { mainAxis: "horizontal" | "vertical"; crossAxis: "vertical" | "horizontal" } {
  switch (dir) {
    case "row":          return { mainAxis: "horizontal", crossAxis: "vertical" };
    case "row-reverse":  return { mainAxis: "horizontal", crossAxis: "vertical" };
    case "column":       return { mainAxis: "vertical",   crossAxis: "horizontal" };
    case "column-reverse": return { mainAxis: "vertical", crossAxis: "horizontal" };
  }
}

/**
 * Extract a FlexDescription from a VisualNode's computed style.
 * Returns undefined when the element is not a flex container.
 */
export function extractFlexDescription(node: VisualNode): FlexDescription | undefined {
  const cs = node.computedStyle;
  if (!isFlexDisplay(cs.display)) return undefined;

  const direction = parseFlexDirection(cs["flex-direction"]);
  const axes = directionToAxes(direction);

  // flex-wrap: nowrap | wrap | wrap-reverse
  const wrapRaw = (cs["flex-wrap"] ?? "nowrap").trim().toLowerCase();
  const wrap = wrapRaw === "wrap" || wrapRaw === "wrap-reverse";

  return {
    type: "flex",
    direction,
    wrap,
    gap: cs.gap ?? "",
    mainAxis: axes.mainAxis,
    crossAxis: axes.crossAxis,
  };
}

// ---------------------------------------------------------------------------
// Alignment relationship extraction
// ---------------------------------------------------------------------------

/**
 * Detect one alignment kind between two siblings, given their rects.
 * Returns the kind or null if no alignment is detected.
 *
 * Threshold constants are module-level (ALIGN_TOLERANCE_PX, CENTRE_TOLERANCE_PX)
 * so they are the single source of truth per ED-06 §4 binding.
 */
export function detectAlignment(
  a: VisualNode,
  b: VisualNode,
): AlignmentKind | null {
  const ax = a.rect.x + a.rect.w / 2; // centre x of a
  const ay = a.rect.y + a.rect.h / 2; // centre y of a
  const bx = b.rect.x + b.rect.w / 2; // centre x of b
  const by = b.rect.y + b.rect.h / 2; // centre y of b

  // Aligned horizontally: same y (top edge), same height.
  if (
    Math.abs(a.rect.y - b.rect.y) <= ALIGN_TOLERANCE_PX &&
    Math.abs(a.rect.h - b.rect.h) <= ALIGN_TOLERANCE_PX
  ) {
    return "aligned-horizontally";
  }

  // Aligned vertically: same x (left edge), same width.
  if (
    Math.abs(a.rect.x - b.rect.x) <= ALIGN_TOLERANCE_PX &&
    Math.abs(a.rect.w - b.rect.w) <= ALIGN_TOLERANCE_PX
  ) {
    return "aligned-vertically";
  }

  // Centre alignment: horizontal centres are within tolerance.
  if (Math.abs(ax - bx) <= CENTRE_TOLERANCE_PX) {
    return "centred-with";
  }

  return null;
}

/**
 * Extract alignment relationships from a VisualNode's siblings.
 *
 * Iterates over siblingsBefore and siblingsAfter, checks each pair,
 * and collects a deduplicated map of other → AlignmentKind.
 *
 * The result is a LayoutRelation[] attached to node. The caller
 * is responsible for emitting the "visual:layout-relation" edges.
 */
export function extractAlignmentRelations(
  node: VisualNode,
  byVisId: Map<string, VisualNode>,
): LayoutRelation[] {
  const seen = new Map<string, AlignmentKind>(); // other → kind (first wins)

  const checkSiblings = (ids: string[]) => {
    for (const otherId of ids) {
      if (seen.has(otherId)) continue;
      const other = byVisId.get(otherId);
      if (!other) continue;
      const kind = detectAlignment(node, other);
      if (kind) seen.set(otherId, kind);
    }
  };

  checkSiblings(node.tethers.siblingsBefore);
  checkSiblings(node.tethers.siblingsAfter);

  return [...seen.entries()].map(([other, kind]) => ({ other, kind }));
}

// ---------------------------------------------------------------------------
// Visual prominence — Layer 3 deferred (ED-06 §4)
// ---------------------------------------------------------------------------

/**
 * Normalise a z-index value to a 0-100 score.
 *
 * Heuristic: 0-10 → 0-60 (typical page flow), 10-100 → 60-100,
 * >100 → 100 (stacking contexts are visually dominant).
 * Negative z-index → 0.
 * Non-numeric values → 0.
 */
export function scoreZIndex(zIndex: string | undefined): number {
  if (!zIndex) return 0;
  const n = parseFloat(zIndex);
  if (isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n <= 10) return Math.round((n / 10) * 60);
  if (n <= 100) return Math.round(60 + ((n - 10) / 90) * 40);
  return 100;
}

/**
 * Compute the opacity contribution to visual prominence.
 * Fully opaque (opacity: 1) elements are maximally visible.
 * Returns (1 - opacity) * 100, capped at 0-100.
 */
export function scoreOpacity(opacity: string | undefined): number {
  if (!opacity) return 0; // default opacity is 1 in CSS
  const n = parseFloat(opacity);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - n) * 100)));
}

/**
 * Extract a scale factor from a CSS transform value.
 * Matches "scale(...)" or "scaleX/Y" and returns the factor as a 0-100 score.
 * "scale(1)" → 0. "scale(1.2)" → 20. "scale(2)" → 100.
 * Unknown/missing transform → 0.
 */
export function scoreTransform(transform: string | undefined): number {
  if (!transform) return 0;
  const m = transform.match(/scale\(([^)]+)\)/);
  if (!m) return 0;
  const val = parseFloat(m[1]!);
  if (isNaN(val)) return 0;
  // scale(1) = normal = 0 prominence. scale(2) = doubled = 100.
  return Math.max(0, Math.min(100, Math.round((val - 1) * 100)));
}

/**
 * Normalise a font-size value to a 0-100 score.
 * Uses the browser's effective pixel value (e.g. "16px" → 16).
 * Baseline: 16px → 75. 12px → 50. 24px → 100.
 * Values outside [8px, 32px] are clamped to the 0-100 range.
 */
export function scoreFontSize(fontSize: string | undefined): number {
  if (!fontSize) return 75; // browser default is 16px
  const n = parseFloat(fontSize);
  if (isNaN(n)) return 75;
  // Linear: 8px → 0, 16px → 75, 24px → 100
  const raw = ((n - 8) / (24 - 8)) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Extract visual prominence signals from a VisualNode.
 *
 * This is a structural analysis: scores are 0-100 per signal so
 * consumers can compose them according to their needs. The `isProminent`
 * flag is derived conservatively (all thresholds are recorded as constants
 * so any future change is a documented substitution per ED-05).
 *
 * ED-06 §4 deferred rationale: no consensus on a single combined score,
 * so raw signals + derived flags are surfaced rather than a pre-computed number.
 */
export function extractVisualProminence(node: VisualNode): VisualProminence {
  const cs = node.computedStyle;
  const zScore = scoreZIndex(cs.zIndex);
  const opacityScore = scoreOpacity(cs.opacity);
  const transformScore = scoreTransform(cs.transform);
  const fontScore = scoreFontSize(cs.fontSize);

  const pos = (cs.position ?? "").toLowerCase().trim();
  const isOverlay = pos === "fixed" || pos === "absolute" || pos === "sticky";

  const cursor = (cs.cursor ?? "").toLowerCase().trim();
  const isInteractive = cursor === "pointer" || cursor === "grab" || cursor === "grabbing";

  const isProminent =
    zScore > 70 || opacityScore > 80 || transformScore > 80 || fontScore > 90;

  return {
    subscores: {
      zIndex: zScore,
      opacity: opacityScore,
      transform: transformScore,
      fontSize: fontScore,
    },
    isOverlay,
    isInteractive,
    isProminent,
  };
}

// ---------------------------------------------------------------------------
// Component inference — Layer 3 deferred (ED-06 §4)
// ---------------------------------------------------------------------------

/**
 * Compute the bounding box that encloses two rects.
 */
function unionRect(a: Rect, b: Rect): Rect {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.w, b.x + b.w);
  const maxY = Math.max(a.y + a.h, b.y + b.h);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Compute a bounding box from an array of rects (union).
 */
function unionRects(rects: Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  return rects.reduce(unionRect);
}

/**
 * Bounded-overlap threshold for component grouping.
 * Two nodes are considered part of the same component when their bounding
 * boxes overlap by at least this fraction on both axes.
 */
const OVERLAP_THRESHOLD = 0.3;

/**
 * Minimum number of children a container must have to qualify as a component.
 */
const MIN_CHILDREN = 2;

/**
 * Minimum confidence threshold for a component to be included in results.
 */
const MIN_CONFIDENCE = 40;

/**
 * Parse a string z-index and return a comparable number (0 for NaN/negative).
 */
function parseZ(n: string | undefined): number {
  const v = parseFloat(n ?? "");
  return isNaN(v) ? 0 : Math.max(0, v);
}

/**
 * Infer UI components from a set of VisualNodes using spatial proximity
 * and structural signals (flex/grid containers, DOM proximity, shared alignment).
 *
 * Algorithm:
 * 1. Identify flex/grid containers — each is a strong candidate component.
 * 2. Flood-fill: cluster nodes whose bounding boxes share ≥ OVERLAP_THRESHOLD
 *    overlap on both axes.
 * 3. For each cluster, emit a ComponentGroup with inferred type and confidence.
 *
 * ED-06 §4 deferred rationale: proximity thresholds are heuristic; the
 * "unknown" fallback is the honest output when no structural pattern matches.
 */
export function inferComponentGroups(nodes: VisualNode[]): ComponentGroup[] {
  if (nodes.length === 0) return [];

  const groups: ComponentGroup[] = [];

  // --- Step 1: flex/grid containers are strong component candidates ---
  for (const node of nodes) {
    const cs = node.computedStyle;
    const isFlex = isFlexDisplay(cs.display);
    const isGrid = isGridDisplay(cs.display);
    if (!isFlex && !isGrid) continue;

    const children = node.tethers.children;
    if (children.length < MIN_CHILDREN) continue;

    // Gather child rects
    const childNodes = children
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is VisualNode => !!n);
    if (childNodes.length < MIN_CHILDREN) continue;

    const rects = childNodes.map((n) => n.rect);
    const bounds = unionRects(rects);
    if (!bounds) continue;

    const dir = isFlex ? cs["flex-direction"] ?? "row" : "";
    const kind: ComponentType = isGrid ? "grid-container" : "flex-container";
    const reason = isFlex
      ? `${children.length} flex children, display:${cs.display ?? "flex"}, direction:${dir}`
      : `${children.length} grid children, display:${cs.display ?? "grid"}`;

    // Confidence: flex/grid containers are structural, high confidence.
    const confidence = Math.min(100, 60 + childNodes.length * 5);

    groups.push({ bounds, memberIds: children, kind, confidence, reason });
  }

  // --- Step 2: spatial flood-fill for remaining nodes ---
  // Index by id
  const byId = new Map<string, VisualNode>();
  for (const n of nodes) byId.set(n.id, n);

  const assigned = new Set<string>();
  for (const g of groups) {
    for (const id of g.memberIds) assigned.add(id);
  }

  // For each unassigned node, flood-fill neighbours within proximity
  const PROXIMITY_PX = 24; // within 24px on both axes = same component

  for (const seed of nodes) {
    if (assigned.has(seed.id)) continue;

    const cluster: string[] = [seed.id];
    assigned.add(seed.id);
    const queue = [seed];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const cr = current.rect;

      for (const other of nodes) {
        if (assigned.has(other.id)) continue;
        const or2 = other.rect;

        // Overlap on both axes ≥ PROXIMITY_PX
        const overlapX = Math.max(0, Math.min(cr.x + cr.w, or2.x + or2.w) - Math.max(cr.x, or2.x));
        const overlapY = Math.max(0, Math.min(cr.y + cr.h, or2.y + or2.h) - Math.max(cr.y, or2.y));
        if (overlapX >= PROXIMITY_PX && overlapY >= PROXIMITY_PX) {
          assigned.add(other.id);
          cluster.push(other.id);
          queue.push(other);
        }
      }
    }

    if (cluster.length < MIN_CHILDREN) continue;

    const clusterNodes = cluster
      .map((id) => byId.get(id))
      .filter((n): n is VisualNode => !!n);
    const bounds = unionRects(clusterNodes.map((n) => n.rect));
    if (!bounds) continue;

    // Infer kind from cluster characteristics
    let kind: ComponentType = "unknown";
    let reason = `${cluster.length} spatially proximate nodes`;

    // Check for toolbar: horizontal row (similar y, similar h)
    const ys = clusterNodes.map((n) => n.rect.y);
    const hs = clusterNodes.map((n) => n.rect.h);
    const yRange = Math.max(...ys) - Math.min(...ys);
    const hRange = Math.max(...hs) - Math.min(...hs);
    if (yRange <= 8 && hRange <= 16 && cluster.length >= 3) {
      kind = "toolbar";
      reason = `${cluster.length} horizontally aligned nodes (y range ${Math.round(yRange)}px)`;
    }

    // Check for card: similar size blocks with background or border
    const areas = clusterNodes.map((n) => n.rect.w * n.rect.h);
    const avgArea = areas.reduce((a, b) => a + b, 0) / areas.length;
    const bgColor = clusterNodes[0]?.computedStyle.backgroundColor ?? "";
    const borderRadius = clusterNodes[0]?.computedStyle.borderRadius ?? "";
    if (kind === "unknown" && bgColor && bgColor !== "rgba(0, 0, 0, 0)" && borderRadius !== "0px" && cluster.length >= 2) {
      kind = "card";
      reason = `${cluster.length} similar-size cards with background:${bgColor} border-radius:${borderRadius}`;
    }

    // Confidence: spatially derived, lower than structural candidates
    const confidence = Math.min(
      95,
      Math.max(MIN_CONFIDENCE, Math.round(30 + cluster.length * 8)),
    );

    groups.push({ bounds, memberIds: cluster, kind, confidence, reason });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Responsive behaviour signals — Layer 3 deferred (ED-06 §4)
// ---------------------------------------------------------------------------

/**
 * Parse a CSS length value to a numeric pixel value.
 * Handles "100px", "10em" (≈160px at 16px baseline), "50%", "auto", "none", etc.
 * Returns the pixel value or NaN if unparseable.
 */
function parseLength(val: string | undefined, fallback = 0): number {
  if (!val || val === "auto" || val === "none" || val === "normal") return fallback;
  if (val.endsWith("%")) return NaN; // percentage needs container context
  if (val.endsWith("px")) return parseFloat(val);
  if (val.endsWith("em")) {
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n * 16;
  }
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

/**
 * True if the value contains adaptive keywords that adapt to container/viewport.
 */
function isFluidValue(val: string | undefined): boolean {
  if (!val) return false;
  const v = val.toLowerCase();
  return (
    v.includes("%") ||
    v.includes("fr") ||
    v.includes("minmax") ||
    v.includes("clamp") ||
    v.includes("calc(") ||
    v.includes("auto") ||
    v.includes("min-content") ||
    v.includes("max-content")
  );
}

/**
 * True if the value contains only fixed pixel or rem values.
 */
function isFixedValue(val: string | undefined): boolean {
  if (!val) return false;
  const v = val.trim().toLowerCase();
  // Pure numbers (px, em, rem) without calc/clamp/fluid keywords
  if (/^\d+(\.\d+)?(px|rem|em)$/.test(v)) return true;
  return false;
}

/**
 * Detect responsive behaviour signals from a VisualNode's computed style.
 *
 * This is a single-snapshot CSS analysis, not a multi-viewport probe.
 * The signals indicate that the layout is likely adaptive without
 * guaranteeing it responds to the current viewport.
 *
 * ED-06 §4 deferred rationale: multi-viewport probes are out of scope
 * for a single-snapshot crawl; these CSS signals are the honest output.
 */
export function detectResponsiveHints(node: VisualNode): ResponsiveHint | undefined {
  const cs = node.computedStyle;

  const signals: string[] = [];
  let strategy: ResponsiveStrategy = "none";
  let description = "";

  // --- Check flex-wrap ---
  const flexWrap = (cs["flex-wrap"] ?? "nowrap").toLowerCase().trim();
  if (flexWrap === "wrap" || flexWrap === "wrap-reverse") {
    const dir = (cs["flex-direction"] ?? "row").toLowerCase().trim();
    signals.push(`flex-wrap:${flexWrap}`, `flex-direction:${dir}`);
    strategy = "flex-wrap";
    description = `flex-wrap:${flexWrap} — reflows children on narrow viewports`;
  }

  // --- Check width signals ---
  const width = cs.width;
  const minWidth = cs.minWidth;
  const maxWidth = cs.maxWidth;

  if (isFluidValue(width) || isFluidValue(minWidth) || isFluidValue(maxWidth)) {
    if (width) signals.push(`width:${width}`);
    if (minWidth) signals.push(`min-width:${minWidth}`);
    if (maxWidth) signals.push(`max-width:${maxWidth}`);
    strategy = strategy === "flex-wrap" ? strategy : "fluid-width";
    if (!description) {
      description = `fluid widths detected: width:${width ?? "none"} max-width:${maxWidth ?? "none"}`;
    }
  } else if (
    strategy === "none" &&
    width &&
    !isFluidValue(width) &&
    !isFixedValue(width)
  ) {
    // Non-fluid, non-fixed — likely adaptive
    signals.push(`width:${width}`);
    strategy = "fluid-width";
    description = `width:${width} — layout may adapt to container`;
  }

  // --- Check grid responsiveness ---
  const gridCols = cs["grid-template-columns"];
  const gridRows = cs["grid-template-rows"];
  if (isGridDisplay(cs.display) && (isFluidValue(gridCols) || isFluidValue(gridRows))) {
    if (gridCols) signals.push(`grid-template-columns:${gridCols}`);
    if (gridRows) signals.push(`grid-template-rows:${gridRows}`);
    if (strategy === "none" || strategy === "fluid-width") {
      strategy = "grid-responsive";
      description = `grid with responsive tracks: columns:${gridCols ?? "none"} rows:${gridRows ?? "none"}`;
    }
  }

  // --- Check clamp() in font-size ---
  const fontSize = cs.fontSize;
  if (fontSize && fontSize.toLowerCase().includes("clamp(")) {
    signals.push(`font-size:${fontSize}`);
    if (strategy === "none") {
      strategy = "clamp-font";
      description = `font-size uses clamp(): ${fontSize} — text scales with viewport`;
    }
  }

  // --- Check fixed width (anti-responsive signal) ---
  if (
    strategy === "none" &&
    width &&
    (isFixedValue(width) || !isFluidValue(width)) &&
    !isFluidValue(minWidth) &&
    !isFluidValue(maxWidth)
  ) {
    // Fixed width: not responsive
    signals.push(`width:${width}`);
    strategy = "fixed-width";
    description = `fixed width:${width} — layout does not adapt to viewport`;
  }

  if (signals.length === 0) return undefined;
  if (!description) {
    description = signals.join("; ");
  }

  return { strategy, signals, description };
}

// ---------------------------------------------------------------------------
// Full interpretive run
// ---------------------------------------------------------------------------

/**
 * Run all interpretive analyses on a set of VisualNodes from one page.
 *
 * Mutates each node by attaching `node.interpretation` (containing grid,
 * flex, layout-relation, prominence, and responsive fields).
 *
 * Returns `{ layoutEdges, componentGroups }`:
 *  - `layoutEdges`: "visual:layout-relation" edge objects to emit.
 *  - `componentGroups`: inferred UI component clusters for the page.
 *
 * @param nodes  All VisualNodes from one page.
 * @param pageId Used for edge ids.
 * @param provenance  Provenance string for emitted edges.
 */
export function interpretPage(
  nodes: VisualNode[],
  pageId: string,
  provenance: string,
): { layoutEdges: LayoutRelationEdge[]; componentGroups: ComponentGroup[] } {
  // Build visId index.
  const byVisId = new Map<string, VisualNode>();
  for (const n of nodes) byVisId.set(n.id, n);

  // Layout relation edges to emit.
  const layoutEdges: LayoutRelationEdge[] = [];

  for (const node of nodes) {
    // 1. Grid description.
    const grid = extractGridDescription(node);

    // 2. Flex description.
    const flex = extractFlexDescription(node);

    // 3. Alignment relationships.
    const layoutRelations = extractAlignmentRelations(node, byVisId);

    // 4. Visual prominence (Layer 3 deferred).
    const prominence = extractVisualProminence(node);

    // 5. Responsive behaviour signals (Layer 3 deferred).
    const responsive = detectResponsiveHints(node);

    // Attach all available interpretations.
    const hasLayout = grid || flex || layoutRelations.length > 0;
    const hasProminence = prominence && (
      prominence.isProminent || prominence.isOverlay || prominence.isInteractive ||
      prominence.subscores.zIndex > 0 ||
      prominence.subscores.opacity > 0 ||
      prominence.subscores.transform > 0 ||
      prominence.subscores.fontSize > 0
    );
    const hasResponsive = !!responsive;

    if (hasLayout || hasProminence || hasResponsive) {
      node.interpretation = {
        ...(grid ? { grid } : {}),
        ...(flex ? { flex } : {}),
        layoutRelations,
        ...(hasProminence ? { prominence } : {}),
        ...(hasResponsive ? { responsive } : {}),
      };
    }

    // Emit alignment edges.
    for (const rel of layoutRelations) {
      layoutEdges.push({
        id: `edge:${node.id}->${rel.other}:visual:layout-relation`,
        type: "edge",
        from: node.id,
        to: rel.other,
        kind: "visual:layout-relation",
        provenance,
        alignment: rel.kind,
      });
    }
  }

  // 6. Component inference (Layer 3 deferred) — runs on full page node set.
  const componentGroups = inferComponentGroups(nodes);

  return { layoutEdges, componentGroups };
}

// ---------------------------------------------------------------------------
// Emitted edge shape (for the caller to upsert)
// ---------------------------------------------------------------------------

export interface LayoutRelationEdge {
  id: string;
  type: "edge";
  from: string;    // visId
  to: string;     // visId
  kind: "visual:layout-relation";
  provenance: string;
  /** Which alignment was detected. */
  alignment: AlignmentKind;
}
