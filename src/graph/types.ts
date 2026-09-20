/**
 * Graph node and edge types — the source of truth for the Agent Web Graph
 * data model. Mirrors plan section 4.
 *
 * Every node has:
 *  - `id` — globally unique within the graph (namespace-prefixed)
 *  - `type` — discriminator
 *  - `provenance` — auditability spine per section 4.8
 *
 * IDs follow the grammar: `<kind>:<slug>` where kind ∈
 * {page, ax, vis, edge, cap, trans, snapshot, screenshot}.
 */
import type { SecurityTier } from "./security.js";

// ----- Provenance grammar (plan section 4.8) -----
export type ProvenanceSource =
  | "html"
  | "bidi"
  | "cdp"
  | "aria"
  | "apg"
  | "dom-diff"
  | "token-walk"
  | "declared"
  | "desktop"
  | "mobile";

/** Format: `<source>:<operation>[:<call>]` e.g. "bidi:script.callFunction" */
export type Provenance = `${ProvenanceSource}:${string}`;

// ----- AX (accessibility) states — plan section 4.2 -----
export type AxRole =
  | "button" | "link" | "textbox" | "searchbox" | "checkbox" | "radio"
  | "switch" | "combobox" | "listbox" | "option" | "menuitem" | "tab"
  | "dialog" | "alertdialog" | "slider" | "spinbutton" | "progressbar"
  | "heading" | "img" | "navigation" | "main" | "region" | "banner"
  | "contentinfo" | "complementary" | "form" | "group" | "list" | "listitem"
  | "table" | "row" | "cell" | "columnheader" | "rowheader" | "tooltip"
  | "status" | "log" | "timer" | "separator" | "presentation" | "none"
  | (string & {}); // allow extensions

export type NameSource = "aria-label" | "aria-labelledby" | "label" | "content" | "title" | "placeholder" | "alt" | (string & {});

export interface AxStates {
  expanded: boolean | null;
  disabled: boolean | null;
  pressed: boolean | null;
  selected: boolean | null;
  checked: boolean | null;
  busy: boolean | null;
  /**
   * PR-8f: open state for dialogs and popovers. Read from the
   * `open` attribute (which is the public observation surface for
   * `<dialog>` and elements with `popover` semantics). Captured by
   * the structural walker so the declared and observed paths
   * produce identical state ids when the page's open state is
   * unchanged (without this, a closed popover with the `popover`
   * attribute present hashes differently on the two paths because
   * the rich-snapshot walker reads `open: false` while the
   * declared path had no `open` field at all).
   */
  open: boolean | null;
  current: "page" | "step" | "location" | "date" | "time" | true | false | null;
}

export interface AxProperties {
  controls: string[];        // axIds
  describedBy: string[];
  labelledBy: string[];
  level: number | null;
  live: "polite" | "assertive" | "off" | null;
  orientation: "horizontal" | "vertical" | null;
  posInSet: number | null;
  setSize: number | null;
  valueNow: number | null;
  valueMin: number | null;
  valueMax: number | null;
  valueText: string | null;
}

// ----- Node types -----

export interface PageNode {
  id: string;            // "page:<canonical-url>"
  type: "page";
  url: string;
  title: string;
  discoveredVia: string[];
  loadStatus: "complete" | "interactive" | "spa-error" | "timeout";
  axTreeRef: { rootAxId: string; provenance: Provenance };
  viewport: { w: number; h: number; dpr: number };
  tokensOverride: string | null;  // design token name (e.g. "dark") or null
  screenshotRef: string | null;  // "screenshot:<sha256>"
  canonicalUrl: string;
  crawledAt: string;     // ISO 8601
  /**
   * Page id of the parent in the navigation hierarchy, or null for the
   * entry/root URL. Per ED-03: the navigation graph is a hierarchy, not a
   * flat set. The orchestrator populates this after each page is crawled,
   * using the URL-prefix rule (primary) and the referrer fallback; the
   * corresponding `nav:child-of` edges are emitted from parent to child.
   */
  parentPageId: string | null;
}

export interface AxNode {
  id: string;            // "ax:<n>"
  type: "ax-node";
  pageId: string;
  role: AxRole;
  name: string;
  nameSource: NameSource;
  states: AxStates;
  properties: AxProperties;
  apgPattern: string | null;
  focusable: boolean;
  /**
   * Computed visibility at structural-walk time (PR-8e). The declared
   * materializer uses this directly to populate
   * `ElementStateObservation.visibility`, so declared and observed
   * states agree on element visibility and state ids converge when
   * the application's real state is unchanged.
   */
  visibility: "visible" | "hidden" | "display-none" | "offscreen";
  inPageDomOrder: number;
  /**
   * axId of the parent in the a11y tree, or null for the document root.
   * Per ED-04: the a11y tree is a tree. The structural extractor emits
   * the corresponding `a11y:child-of` edges; this field is the denormalized
   * parent pointer so queries can answer "what is the parent of this node?"
   * without traversing edges.
   */
  parentAxId: string | null;
  provenance: Provenance;
}

export interface Rect { x: number; y: number; w: number; h: number; }

export interface Tethers {
  parent: string | null;          // visId
  children: string[];            // visIds
  siblingsBefore: string[];      // visIds
  siblingsAfter: string[];       // visIds
  anchors: Array<{ name: string; target: string }>;  // {anchor-name, visId}
}

export interface ComputedStyleSnapshot {
  // color / background
  color?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  // typography
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  // box / layout
  display?: string;
  position?: string;
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
  width?: string;
  height?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;
  maxHeight?: string;
  margin?: string;
  padding?: string;
  borderRadius?: string;
  overflow?: string;
  visibility?: string;
  // VI-02: layout-box and box-model properties
  boxSizing?: string;
  aspectRatio?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  borderTopWidth?: string;
  borderRightWidth?: string;
  borderBottomWidth?: string;
  borderLeftWidth?: string;
  borderStyle?: string;
  borderColor?: string;
  // overflow / visibility
  overflowX?: string;
  overflowY?: string;
  // effects
  opacity?: string;
  transform?: string;
  filter?: string;
  zIndex?: string;
  cursor?: string;
  boxShadow?: string;
  isolation?: string;
  mixBlendMode?: string;
  willChange?: string;
  clipPath?: string;
  contain?: string;
  // grid / flex
  "grid-template-columns"?: string;
  "grid-template-rows"?: string;
  "column-gap"?: string;
  "row-gap"?: string;
  "flex-direction"?: string;
  "flex-wrap"?: string;
  "flex-grow"?: string;
  "flex-shrink"?: string;
  "flex-basis"?: string;
  alignItems?: string;
  justifyContent?: string;
  alignContent?: string;
  alignSelf?: string;
  justifySelf?: string;
  gap?: string;
  // CSS Anchor Positioning
  anchorName?: string;
  positionAnchor?: string;
  [key: string]: string | undefined;
}

// ----- PR-11: Layer 3 interpretive layer (ED-06) -----
//
// The visual substrate captures raw geometry and style (rects, computed
// properties, tether relations, design tokens). The interpretive layer
// analyzes those primitives and emits structured descriptions.
//
// Grid description: for an element with display:grid/inline-grid,
// the track structure of the grid. Track values are captured as
// raw CSS strings — the brief (§5) shows "width: 1200px", not
// a parsed AST, so the raw value is the right level of description.
export interface GridDescription {
  type: "grid";
  /** Raw grid-template-columns value, e.g. "1fr 2fr" or "repeat(3, 1fr)". */
  columns: string[];
  /** Raw grid-template-rows value, e.g. "auto 1fr auto". */
  rows: string[];
  columnGap: string;
  rowGap: string;
}

// Flex description: for an element with display:flex/inline-flex,
// the flex container configuration.
export interface FlexDescription {
  type: "flex";
  direction: "row" | "column" | "row-reverse" | "column-reverse";
  wrap: boolean;
  gap: string;
  /** Derived from direction. */
  mainAxis: "horizontal" | "vertical";
  /** Derived from direction. */
  crossAxis: "vertical" | "horizontal";
}

// Alignment kinds between sibling elements (ED-06 §4 binding,
// ±2px for sibling equality, ±4px for centre alignment).
export type AlignmentKind =
  | "aligned-horizontally"   // same y, same height (±2px)
  | "aligned-vertically"    // same x, same width (±2px)
  | "centred-with";         // midpoint alignment (±4px)

/**
 * One layout relationship from one sibling to another.
 * Stored on VisualNode.interpretation.layoutRelations.
 * Edges of kind "visual:layout-relation" are also emitted.
 */
export interface LayoutRelation {
  /** visId of the related sibling. */
  other: string;
  kind: AlignmentKind;
}

// Complete interpretation attached to a VisualNode.
export interface VisualInterpretation {
  /** Grid description, if this element is a grid container. */
  grid?: GridDescription;
  /** Flex description, if this element is a flex container. */
  flex?: FlexDescription;
  /**
   * Layout relationships to sibling elements.
   * Deduplicated: at most one edge per (other, kind) pair.
   */
  layoutRelations: LayoutRelation[];
  /**
   * Layer 3 deferred — visual prominence (ED-06 §4 deferred).
   * Which visual signals make this element stand out.
   */
  prominence?: VisualProminence;
  /**
   * Layer 3 deferred — responsive behaviour signals (ED-06 §4 deferred).
   * Attached only when at least one responsive CSS signal is detected.
   */
  responsive?: ResponsiveHint;
}

// ---------------------------------------------------------------------------
// Layer 3 deferred: Visual Prominence (ED-06 §4 deferred)
//
// No consensus heuristic for weighting z-index + opacity + transform +
// font-size + contrast into a single score, so this records each signal
// separately and lets the consumer compose them. The score is 0-100 where
// 100 = maximum visual weight for a typical web page.
// ---------------------------------------------------------------------------

/** Sub-scores for the prominent signals; each is 0-100. */
export interface VisualProminenceSubscores {
  zIndex: number;   // normalised z-index score
  opacity: number; // opacity contribution (1-opacity gives a weight)
  transform: number; // scale factor extracted from transform
  fontSize: number; // normalised relative to 16px baseline
}

/**
 * Layer 3 deferred — visual prominence for a single element.
 * ED-06 §4 deferred: no consensus heuristic, so raw signals are surfaced
 * alongside derived flags rather than a single pre-computed score.
 */
export interface VisualProminence {
  /**
   * Per-signal scores (0-100). Consumers can weight these per their needs.
   * `zIndex`: z-index normalised: 0-10 → 0-60, 10-100 → 60-100, >100 → 100.
   * `opacity`: `(1 - parseFloat(opacity)) * 100`, falls back to 0.
   * `transform`: extracted scale factor, e.g. "scale(1.2)" → 20 (of 100).
   * `fontSize`: font-size in px normalised: 12px → 50, 16px → 75, 24px → 100.
   */
  subscores: VisualProminenceSubscores;
  /**
   * True if the element is an overlay (position:fixed/absolute/sticky).
   * Overlaid elements compete for attention and are visually dominant.
   */
  isOverlay: boolean;
  /**
   * True if the element is interactive (button, link, etc.) or has a
   * pointer cursor — interactive elements are inherently attention targets.
   */
  isInteractive: boolean;
  /**
   * True if the element is visually prominent by any single signal.
   * Threshold: zIndex score > 70 OR opacity score > 80 OR
   * transform score > 80 OR fontSize score > 90.
   */
  isProminent: boolean;
}

// ---------------------------------------------------------------------------
// Layer 3 deferred: Component Inference (ED-06 §4 deferred)
//
// No consensus proximity threshold for spatial grouping ("these 5 cards are
// one logical group"). We use a bounded-overlap heuristic: nodes whose
// bounding boxes share significant overlap along both axes are grouped.
// This is a structural heuristic, not semantic — form labels and inputs
// are grouped by DOM proximity rather than role inference.
// ---------------------------------------------------------------------------

/** Inferred kind of a component group. */
export type ComponentType =
  | "flex-container"   // display:flex or inline-flex with ≥2 children
  | "grid-container"  // display:grid or inline-grid with ≥2 children
  | "form-group"      // fieldsets, label+input pairs, grouped inputs
  | "card"           // bordered/background blocks with multiple children
  | "list"           // ordered/unordered lists, listbox-like structures
  | "toolbar"        // horizontal row of action buttons/links
  | "navigation"     // nav-like structures
  | "overlay"        // dialog, popover, tooltip, fixed/sticky panel
  | "unknown";       // fallback when no pattern matches

/** Confidence that the group is a genuine component (0-100). */
export type ComponentConfidence = number;

/**
 * One inferred component — a spatial cluster of visual nodes that likely
 * represent a single UI component.
 */
export interface ComponentGroup {
  /**
   * Bounding box that encloses all member nodes.
   * Useful for rendering an outline or querying the region.
   */
  bounds: Rect;
  /** Visual node ids that are members of this group. */
  memberIds: string[];
  /** Inferred semantic type. */
  kind: ComponentType;
  /** Confidence (0-100) that the group is a genuine component. */
  confidence: ComponentConfidence;
  /**
   * Human-readable rationale for the inference.
   * E.g. "3 flex children within 8px vertical gap, display:flex, direction:row"
   */
  reason: string;
}

// ---------------------------------------------------------------------------
// Layer 3 deferred: Responsive Behaviour (ED-06 §4 deferred)
//
// Requires multi-viewport probes to fully characterise, which is out of
// scope for a single-snapshot crawl. We surface the CSS signals that
// typically encode responsive behaviour so consumers can reason about
// adaptivity from the current snapshot.
// ---------------------------------------------------------------------------

/** How the layout adapts at different viewport sizes. */
export type ResponsiveStrategy =
  | "fluid-width"       // percentage / fr / calc() widths — adapts to container
  | "flex-wrap"         // flex-wrap enables reflow on narrow viewports
  | "fixed-width"       // explicit px widths — does NOT adapt
  | "grid-responsive"   // grid with responsive track definitions
  | "clamp-font"        // font-size uses clamp() for viewport-relative scaling
  | "none";            // no responsive signal detected

/**
 * Layer 3 deferred — responsive behaviour signals from the current snapshot.
 * ED-06 §4 deferred: multi-viewport probes are out of scope, so these
 * are single-viewport CSS signals that encode adaptivity, not a full
 * multi-viewport analysis.
 */
export interface ResponsiveHint {
  /**
   * Primary responsive strategy detected from CSS properties.
   * Consumers can treat "fluid-width", "flex-wrap", "grid-responsive" as
   * indicators of viewport-adaptive layout.
   */
  strategy: ResponsiveStrategy;
  /**
   * Relevant raw CSS values that informed the strategy inference.
   * E.g. ["width: 100%", "max-width: 1200px"] for "fluid-width".
   */
  signals: string[];
  /**
   * Human-readable description of the responsive behaviour.
   * E.g. "width:100%; flex-wrap:wrap — reflows to single column on narrow viewports"
   */
  description: string;
}

// ============================================================================
// VI-01: Multi-viewport visual snapshot schemas
// ============================================================================

/**
 * VI-01: Canonical ViewportProfile schema.
 * Represents a viewport configuration with explicit dimensions, DPR, and device flags.
 */
export interface ViewportProfile {
  name: "desktop" | "laptop" | "tablet" | "mobile" | string;
  w: number;
  h: number;
  dpr: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

/**
 * Standard default viewport profile matrix (VI-01).
 * Exact dimensions and DPR are recorded, not merely labels.
 */
export const DEFAULT_VIEWPORT_PROFILES: Record<"desktop" | "laptop" | "tablet" | "mobile", ViewportProfile> = {
  desktop: { name: "desktop", w: 1440, h: 900, dpr: 1 },
  laptop: { name: "laptop", w: 1280, h: 800, dpr: 1 },
  tablet: { name: "tablet", w: 768, h: 1024, dpr: 2, hasTouch: true },
  mobile: { name: "mobile", w: 390, h: 844, dpr: 3, isMobile: true, hasTouch: true },
};

// ============================================================================
// VI-02: Complete layout-box evidence schemas
// ============================================================================

/**
 * 4-edge measurement for margins, borders, paddings in CSS pixels.
 */
export interface BoxEdgeMeasurements {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * VI-02: Complete CSS box-model geometry measurements.
 * Captures explicit content, padding, border, and margin boxes in page coordinates,
 * along with edge widths and box-sizing mode.
 */
export interface BoxModelMeasurements {
  content: Rect;
  padding: BoxEdgeMeasurements;
  border: BoxEdgeMeasurements;
  margin: BoxEdgeMeasurements;
  paddingBox: Rect;
  borderBox: Rect;
  marginBox: Rect;
  boxSizing: "border-box" | "content-box" | string;
}

/**
 * VI-02: Scroll and clipping context.
 * Identifies whether an element establishes a scroll container, its scrollable
 * dimensions, current scroll offsets, overflow clipping, and clip-path.
 */
export interface ScrollClippingContext {
  isScrollContainer: boolean;
  canScrollX: boolean;
  canScrollY: boolean;
  scrollWidth: number;
  scrollHeight: number;
  scrollLeft: number;
  scrollTop: number;
  isClipped: boolean;
  overflowX: string;
  overflowY: string;
  clipPath?: string | null;
  scrollContainerAxId?: string | null;
}

/**
 * VI-02: Stacking context and paint order.
 * Tracks whether an element creates a CSS stacking context, its resolved z-index,
 * the explicit CSS triggers that formed it, and its nearest stacking ancestor.
 */
export interface StackingContextInfo {
  isStackingContext: boolean;
  zIndex: number | "auto";
  reasons: string[];
  stackingParentAxId?: string | null;
}

/**
 * VI-02: Layout vs transformed render bounds.
 * Disambiguates pre-transform layout rectangle from post-transform rendering bounds.
 */
export interface RenderBoundsInfo {
  transformed: Rect;
  layout: Rect;
  hasTransform: boolean;
  transform: string | null;
}

/**
 * VI-02: Visual container / layout wrapper classification.
 * Identifies visual structures (hero, grid, flex, card, section, scroll wrapper)
 * even if they lack explicit ARIA roles.
 */
export type VisualContainerType =
  | "hero"
  | "grid"
  | "flex"
  | "card"
  | "section"
  | "scroll"
  | "container"
  | "wrapper"
  | "none";

// ============================================================================
// VI-04: Semantic visual labeling & high-level pattern schemas
// ============================================================================

/**
 * VI-04: Semantic visual pattern kinds.
 * Identifies recognized high-level UI component patterns and overlays.
 */
export type VisualPatternType =
  | "fab"
  | "modal-backdrop"
  | "dialog-overlay"
  | "sticky-header"
  | "sticky-footer"
  | "dismiss-button"
  | "form-group"
  | "toast-notification";

/**
 * VI-04: Detected visual pattern evidence on a node.
 */
export interface VisualPatternInfo {
  pattern: VisualPatternType;
  confidence: number;
  reasons: string[];
  targetAxId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * VI-04: Responsive layout mutation classification across viewport transitions.
 */
export type LayoutMutationType =
  | "reflow"
  | "hide"
  | "show"
  | "reorder"
  | "reposition"
  | "unchanged";

export interface LayoutMutation {
  type: LayoutMutationType;
  reasons: string[];
  severity: "none" | "low" | "medium" | "high";
}

/**
 * VI-04: Page-level responsive layout mutation analysis across two viewports.
 */
export interface PageLayoutMutations {
  pageId: string;
  fromViewport: ViewportProfile;
  toViewport: ViewportProfile;
  mutations: Array<{
    axId: string;
    diff: ViewportDiff;
    mutation: LayoutMutation;
  }>;
  summary: {
    reflowCount: number;
    hideCount: number;
    showCount: number;
    reorderCount: number;
    repositionCount: number;
    unchangedCount: number;
    totalElements: number;
  };
  breakpointDescription: string;
}

/**
 * VI-03: Occlusion and visible clipping context.
 * Computes exact visible area ratio and identifies occluding overlapping elements.
 */
export interface OcclusionInfo {
  /**
   * Ratio of the element's layout rect that remains visible and unoccluded in [0, 1].
   * 1.0 means 100% visible; 0.0 means completely occluded or offscreen.
   */
  visibleRatio: number;
  /**
   * True if visibleRatio < 0.5 (occluded by other elements or mostly clipped).
   */
  isOccluded: boolean;
  /**
   * IDs of higher paint-order VisualNodes that occlude this element.
   */
  occludedBy: string[];
  /**
   * Intersection of element rect with viewport and ancestor scroll clipping boundaries,
   * before paint-order occlusion subtraction. Null if offscreen or entirely clipped.
   */
  clippedRect: Rect | null;
  /**
   * True if the element's bounding rect is completely outside the viewport or scroll bounds.
   */
  isOffscreen: boolean;
  /**
   * Area in px^2 occluded by overlapping higher-z elements.
   */
  occludedArea: number;
  /**
   * Area in px^2 of the element that is actually visible to the user.
   */
  visibleArea: number;
}

/**
 * VI-01: ViewportObservation schema.
 * Records the visual observation of an element under a specific viewport profile.
 * Preserves identity across viewports without overwriting previous observations.
 */
export interface ViewportObservation {
  viewport: ViewportProfile;
  rect: Rect;
  computedStyle: ComputedStyleSnapshot;
  visibility: "visible" | "hidden" | "display-none" | "offscreen";
  tethers?: Tethers;
  interpretation?: VisualInterpretation;
  crawledAt: string;
  // VI-02: Layout box evidence additions
  isVisualContainer?: boolean;
  containerType?: VisualContainerType;
  boxModel?: BoxModelMeasurements;
  scrollClippingContext?: ScrollClippingContext;
  stackingContext?: StackingContextInfo;
  renderBounds?: RenderBoundsInfo;
  // VI-03: Occlusion additions
  occlusion?: OcclusionInfo;
  // VI-04: Semantic visual patterns
  patterns?: VisualPatternInfo[];
  primaryPattern?: VisualPatternType;
}

/**
 * VI-01: Structured comparison result between two viewport observations.
 * Answers: "What happens to this element between 1440px and 390px?" without
 * taking a new screenshot.
 */
export interface ViewportDiff {
  axId: string;
  fromViewport: ViewportProfile;
  toViewport: ViewportProfile;
  rectDelta: {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
    widthPercentChange: number;
    heightPercentChange: number;
  };
  fromRect: Rect;
  toRect: Rect;
  visibilityChange: {
    from: "visible" | "hidden" | "display-none" | "offscreen";
    to: "visible" | "hidden" | "display-none" | "offscreen";
    changed: boolean;
  };
  styleDeltas: Record<string, { from: string | null; to: string | null }>;
  summary: string;
  /**
   * VI-04: Layout mutation classification (reflow, hide, show, reorder, reposition, unchanged).
   */
  mutation?: LayoutMutation;
}

export interface VisualNode {
  id: string;            // "vis:<n>"
  type: "visual-node";
  axId: string;
  pageId: string;
  rect: Rect;
  computedStyle: ComputedStyleSnapshot;
  designTokenRefs: string[];
  tethers: Tethers;
  provenance: Provenance;
  /**
   * PR-11 (ED-06): interpretive layer additions.
   * Populated by `src/extract-visual/interpret.ts` during extraction.
   */
  interpretation?: VisualInterpretation;
  /**
   * VI-01: Viewport profile under which this observation was made.
   */
  viewport?: ViewportProfile;
  /**
   * VI-01: Multi-viewport visual snapshot observations for this element,
   * keyed by viewport name (e.g. "desktop", "mobile") or "WxH".
   * Preserves identity across viewports so no observation overwrites another.
   */
  viewportObservations?: Record<string, ViewportObservation>;
  /**
   * VI-02: Visual container / layout wrapper classification.
   */
  isVisualContainer?: boolean;
  containerType?: VisualContainerType;
  /**
   * VI-02: Layout box-model geometry measurements.
   */
  boxModel?: BoxModelMeasurements;
  /**
   * VI-02: Scroll and clipping context.
   */
  scrollClippingContext?: ScrollClippingContext;
  /**
   * VI-02: Stacking context and paint order.
   */
  stackingContext?: StackingContextInfo;
  /**
   * VI-02: Layout vs transformed render bounds.
   */
  renderBounds?: RenderBoundsInfo;
  /**
   * VI-03: Occlusion and clipping context.
   */
  occlusion?: OcclusionInfo;
  /**
   * VI-04: Semantic visual patterns (fab, modal-backdrop, sticky-header, etc.).
   */
  patterns?: VisualPatternInfo[];
  primaryPattern?: VisualPatternType;
  /**
   * VI-05: Design token bindings with match confidence.
   */
  designTokenBindings?: TokenBindingEvidence[];
  /**
   * VI-05: Detected token drifts / styling debt.
   */
  tokenDrifts?: TokenDriftReport[];
}

export type EdgeKind =
  | "aria-controls" | "aria-describedBy" | "aria-labelledBy" | "aria-flowsTo"
  | "aria-posinset" | "aria-owns"
  | "commandfor" | "popovertarget" | "dialog-open"
  | "link" | "parent" | "view-transition" | "observed"
  | "a11y:child-of"
  | "nav:child-of"
  // PR-8a: Layer 1 finalization — the four edge kinds that close
  // the remaining gaps in §3 of docs/REQUIREMENTS.md (navigation
  // links, breadcrumbs, menus, tabs, possible transitions).
  | "nav-link" | "breadcrumb" | "menu-of" | "tab-of"
  // PR-8a → PR-8: a "state:cause" edge is a Layer 1 → Layer 4
  // cross-reference. The from-side is a Layer 1 nav/command element
  // (commandfor, popovertarget, dialog-open, apg-tab-activate,
  // breadcrumb item, nav link); the to-side is a state id that PR-8
  // materializes. For PR-8a the to is the documented placeholder
  // id "state:TBD:<fromAxId>:<kind>"; PR-8 T6 resolves it.
  | "state:cause"
  // PR-8: State -> State edges with a `triggers` field. The
  // Interaction/State Graph is a finite state machine; transitions
  // are edges between State nodes.
  | "state:successor" | "state:predecessor"
  // PR-8: cross-layer edges from a State node to the other layers
  // it touches (2F). General and explicit; no special-case hacks.
  | "state:on-page"       // state -> page
  | "state:of-element"    // state -> axId
  | "state:visual"        // state -> visId
  | "state:auth"          // state -> auth:<...> context id
  // PR-8 (2E): emitted only when explicit evidence supports.
  // PR-8b: the materializer in `src/extract-state/state-materialize.ts`
  // emits this edge only when the source axId is the binding axId of
  // a `Capability` already in the graph. No speculative emission.
  | "state-feeds-capability"
  // PR-11 (ED-06): visual layout alignment relationships between sibling elements.
  | "visual:layout-relation"
  // VI-03: Spatial proximity relations
  | "visual:above"
  | "visual:below"
  | "visual:left-of"
  | "visual:right-of"
  | "visual:nested-in";

export interface Edge {
  id: string;            // "edge:<from>-><to>:<kind>"
  type: "edge";
  from: string;          // axId | stateId | pageId | visId | navElementId
  to: string;            // axId | stateId | pageId | visId | navElementId
  kind: EdgeKind;
  provenance: Provenance;
  /**
   * VI-03: Spatial relation metrics (e.g. gap distance and orthogonal overlap).
   */
  spatial?: {
    distance?: number;
    overlap?: number;
  };
  /**
   * PR-8: the triggers that fire this transition (for state:successor /
   * state:predecessor). Optional for backward compat with existing
   * edges. The Edge type stays the same; only the `kind` and `triggers`
   * fields are new.
   */
  triggers?: TransitionTrigger[];
  /**
   * PR-8d (item 7): structural cause metadata for `state:cause` edges
   * and any other edge where the relationship to the target requires
   * more than `from`/`to`/`kind`. The `cause` sub-record identifies:
   *   - the source axId (redundant with `from` for clarity);
   *   - the declared transition kind that produced this edge
   *     (e.g. "commandfor", "popovertarget", "dialog-open",
   *     "apg-tab-activate");
   *   - the actual command value when the kind is "commandfor"
   *     (e.g. "show-modal", "hide-popover", "close", or a custom
   *     "--play-video" string);
   *   - the placeholder state id format used by PR-8a (kept for
   *     backward compat so the resolver can detect unresolved
   *     placeholders by walking edges).
   *
   * Callers MUST set this field on `state:cause` edges (or the
   * resolver falls back to the placeholder-string parse, which the
   * binding rule discourages for new code).
   */
  cause?: {
    sourceAxId: string;
    declaredKind: "commandfor" | "popovertarget" | "dialog-open" | "apg-tab-activate" | "link" | "nav-link" | "choose-dropdown";
    commandValue?: string;
    /**
     * PR-8g T2: for `choose-dropdown` state:cause edges, the
     * chosen option's value (for native <select>) or the
     * active option's id (for ARIA combobox/listbox). The
     * materializer and resolver use this to identify the
     * matching State node. Undefined for non-choose-dropdown
     * edges.
     */
    optionValue?: string;
  };
  /**
   * PR-8d (item 1): for `link` edges only, the href value is preserved
   * separately. The `to` field on a link edge is a sentinel of the
   * form `link:<pageId>:<href>` (not an AxNode id); the original href
   * is repeated here for ergonomics so consumers don't have to parse
   * it back out of the to string.
   */
  hrefValue?: string;
}

export interface CapabilityBinding {
  kind: "ax-node";
  axId: string;
  selector: string;      // re-resolve hint per plan section 8.3
}

export interface Capability {
  id: string;            // "cap:<name>:<n>"
  type: "capability";
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  source: "webmcp" | "fallback";
  binding: CapabilityBinding;
  security: SecurityTier;
  provenance: Provenance;
  pageId: string;
}

// PR-8: expanded trigger vocabulary. The original 7 values are
// preserved; the new 15 cover the full brief §13/§16/§17 trigger list.
//
// PR-8b (item 6): added the fine-grained arrow key + nav key triggers
// (`key-arrow-up`, `key-arrow-down`, `key-arrow-left`,
// `key-arrow-right`, `key-home`, `key-end`) so each ExtendedProbeKind
// can map 1:1 to a TransitionTrigger. The `key-arrow` value is kept
// for backward compat with existing test fixtures but is no longer
// emitted by the observed probe loop.
export type TransitionTrigger =
  | "command" | "click" | "hover" | "focus"
  | "key-enter" | "key-space" | "key-escape"
  | "key-arrow" | "key-arrow-up" | "key-arrow-down"
  | "key-arrow-left" | "key-arrow-right" | "key-home" | "key-end"
  | "key-tab"
  | "type" | "submit" | "scroll" | "drag"
  | "expand" | "collapse"
  | "open-modal" | "close-modal"
  | "switch-tab" | "choose-dropdown"
  | "auth" | "conditional"
  | "view-transition" | "popover" | "dialog" | "network-wait"
  // PR-8c T8: command-specific triggers for Invoker Commands. The
  // declared extractor reads the `command` attribute and emits a
  // semantic trigger (e.g. `command-show-modal`,
  // `command-show-popover`, `command-toggle-popover`,
  // `command-close`, or `command-custom:<name>` for invoker-defined
  // commands). The base `command` value is retained for backward
  // compat when the command cannot be determined.
  | "command-show-modal" | "command-show-popover"
  | "command-toggle-popover" | "command-close"
  | "command-hide-popover" | "command-request-close";
export type ApgPattern = "disclosure" | "dialog" | "menu" | "tabs" | "listbox" | "tree" | "accordion" | "combobox" | (string & {});

export interface Transition {
  id: string;            // "trans:<kind>-<axId>-<n>"
  type: "transition";
  kind: "declared" | "observed";
  trigger: TransitionTrigger;
  fromAxId: string;
  toAxIds: string[];
  beforeSnapshot: string;  // "snapshot:<sha256>"
  afterSnapshot: string;
  apgPattern: ApgPattern | null;
  preconditions: string[];
  provenance: Provenance;
}

// ----- PR-8a: NavElement — Layer 1 navigation-structure nodes -----
// Per ED-03 (and its 2026-08-30 addendum), the brief's §3 also
// requires "navigation links, breadcrumbs, menus, tabs, possible
// transitions". PR-7 only added the parent/child page hierarchy;
// PR-8a closes the rest by introducing a first-class node type
// for the navigation *structures* a page exposes (menus, breadcrumb
// trails, tablists, nav-link sets). Each NavElement is a *Layer 1
// participation* — the underlying ax-nodes still exist; the
// NavElement is the structure they form.
export type NavElementKind =
  | "menu"        // <menu> or [role="menu"]
  | "menubar"     // [role="menubar"]
  | "tablist"     // [role="tablist"]
  | "tab"         // a single [role="tab"] wrapped by a tablist NavElement
  | "breadcrumb"  // <nav aria-label="breadcrumb"> or [aria-label~="breadcrumb"]
  | "nav-link-set"; // a [role="navigation"] container of <a> links

export interface NavElement {
  id: string;            // "nav:<pageId>:<kind>:<n>"
  type: "nav-element";
  pageId: string;
  kind: NavElementKind;
  /** DOM order of the nav container, for stable ids. */
  inPageDomOrder: number;
  /** Underlying axId of the container element (the <nav> for a menu,
   *  the [role=tablist], the <ol> of breadcrumbs). The ax-node still
   *  exists; the NavElement is the L1 *participation*. */
  containerAxId: string;
  /** axIds that participate in this nav structure (the <a> for
   *  nav-link-set, the [role=tab] for a tablist, etc.). Order matters
   *  for breadcrumbs (trail order) and tablists (activation order). */
  memberAxIds: string[];
  /** For tablists: the active tab axId (aria-selected="true" or the
   *  first member when none is explicitly selected). null otherwise. */
  activeMemberAxId: string | null;
  /** Optional name from aria-label or textContent of the container. */
  name: string | null;
  provenance: Provenance;
}

// ----- PR-8: State node type (ED-01 / Layer 4) -----
//
// The Interaction/State Graph is a finite state machine. Each State node
// has a *canonical payload* (2B): the same payload always produces the
// same id. The id is a stable hash of the canonicalized payload; the
// `visualFingerprint` is a small semantic projection (2A) used as an
// index, not a representation. `authContext` (2C) records the
// authentication context the state was observed under; observed
// evidence may annotate, never assert. `networkContext` (2D) records
// the network status (BiDi network events, page shim, or static).
// `evidence` accumulates the kinds of evidence that converged on
// this state (declared, observed, apg-implied, declared+observed).

/** Per-element observation captured between probes (2A). */
export interface ElementStateObservation {
  axId: string;
  rect: { x: number; y: number; w: number; h: number };
  visibility: "visible" | "hidden" | "display-none" | "offscreen";
  zIndex: number | null;
  open: boolean | null;        // dialog/popover
  expanded: boolean | null;     // disclosure
  selected: boolean | null;     // tab/option
  checked: boolean | null;      // checkbox
  pressed: boolean | null;      // button
  busy: boolean | null;
  /**
   * PR-8g T1: true iff this element is the document.activeElement
   * at observation time. Focus is a first-class State field — a
   * focus-only change can become a distinct State. The probe loop
   * uses a real DOM `el.focus()` action to drive the value, NOT a
   * synthesized click. This means a focus probe on a click-only
   * button can ONLY set `focused=true` and CANNOT produce a click
   * application transition (per the trigger-truthfulness matrix).
   */
  focused: boolean | null;
  /** Free-form aria states. */
  ariaStates: Record<string, string | null>;
  /** Pointer to the visual layer for cross-layer traversal (2A, 2F). */
  visualNodeId: string | null;
}

/** Authentication context (2C). */
export type AuthContext =
  | { kind: "anonymous" }
  | { kind: "authenticated"; principal: string; session: string }
  | { kind: "administrator"; principal: string; session: string }
  | { kind: "custom-role"; role: string; principal: string; session: string };

/**
 * Authentication barrier / challenge kind.
 * Represents cryptographic or human verification checkpoints that require
 * user intervention or hardware keys.
 */
export type AuthBarrierKind =
  | "webauthn-hardware"
  | "sms-totp"
  | "captcha-turnstile"
  | "oauth-redirect"
  | "biometric-passkey";

/** First-class representation of an authentication barrier on a State. */
export interface AuthBarrier {
  kind: AuthBarrierKind;
  status: "pending" | "cleared" | "expired";
  prompt?: string;
  detectedAt: string;
  clearedAt?: string;
}

/** Human-in-the-loop handshake event for workflow pausing and causal resumption. */
export interface HITLHandshake {
  id: string;
  barrier: AuthBarrier;
  stateId: string;
  pageId: string;
  timeoutMs: number;
  resumptionTrigger?: string;
}

/**
 * PR-8c T6: a first-class `AuthContextNode` is a persisted graph
 * node so every `state:auth` edge can point at a real graph entity
 * (no dangling `to` references). The id is the same string the
 * materializer's `authIdFor` produces, so the edge target
 * already matches the node id.
 */
export interface AuthContextNode {
  /** `auth:<kind>:<principal>:<session>` — see `authIdFor` in
   *  [src/extract-state/state-materialize.ts:108-119]. */
  id: string;
  type: "auth-context";
  context: AuthContext;
  /** ISO 8601 timestamp of the first observation. */
  firstObservedAt: string;
  /** Count of state nodes that have referenced this context. */
  observationCount: number;
  provenance: Provenance;
}

/** Network context (2D). `evidence` is the *kind of evidence* used. */
export interface NetworkContext {
  status: "online" | "offline" | (string & {});
  /**
   * - "bidi:network" when BiDi network events are available
   * - "page-instrumented" when a fetch/XHR shim was injected
   * - "static" when no evidence was collected (default; recorded for
   *   honesty, not for inference)
   */
  evidence: "bidi:network" | "page-instrumented" | "static";
}

/** Canonical state payload (2B). */
export interface StatePayload {
  /** Page the state is on (denormalized; same as StateNode.pageId). */
  pageId: string;
  /** Resolved route — same as canonicalUrl for now. */
  route: string;
  /** Auth context at observation time. */
  auth: AuthContext;
  /** Network status at observation time. */
  network: NetworkContext;
  /** Per-element observations, keyed by axId. */
  elements: Record<string, ElementStateObservation>;
  /**
   * PR-8g T1: axId of the currently-focused element (or null if
   * focus is on the document body). Recorded at the State level
   * (not just per-element) so a focus change between two
   * snapshots is a deterministic, hash-relevant field. A focus
   * probe that changes this field without changing any other
   * field produces a distinct State — the trigger is `focus`,
   * NOT `click`.
   */
  focusedAxId: string | null;
  /** Cross-cutting "structural" facts. */
  openDialogIds: string[];
  openPopoverIds: string[];
  expandedRegionAxIds: string[];
  viewport: { w: number; h: number; dpr: number; scrollX: number; scrollY: number };
  /** Conditional-rendering markers (e.g. data-condition-xxx). */
  conditionalMarkers: Record<string, string>;
}

/** Evidence kind for a state node. Convergence = "declared+observed". */
export type StateEvidenceKind = "declared" | "observed" | "apg-implied" | "declared+observed";

/** One piece of evidence that converged on a state node. */
export interface StateEvidence {
  kind: StateEvidenceKind;
  /** axId of the element that caused the observation, or the
   *  commandfor / popovertarget source. */
  sourceAxId: string;
  /** The transition id (if any) whose before/after hash is this state. */
  transitionId: string | null;
  /** When this evidence was collected (ISO 8601). */
  at: string;
}

/** A state in the Interaction/State Graph. */
export interface StateNode {
  /** "state:<sha256-hex>". Derived from the canonicalized payload. */
  id: string;
  type: "state";
  pageId: string;
  payload: StatePayload;
  /**
   * Convenience index of the payload (2A). sha256 of a small semantic
   * projection (visibility, rects, zIndex, modal, expanded, viewport,
   * changed visualNode ids). NOT a substitute for `payload`.
   */
  visualFingerprint: string;
  authContext: AuthContext;
  networkContext: NetworkContext;
  provenance: Provenance;
  /** When this state was first observed (ISO 8601). */
  firstObservedAt: string;
  /** Evidence kinds that converged on this state. */
  evidence: StateEvidence[];
}

// ----- DTCG design tokens & bindings (plan section 4.7, VI-05) -----
export type DtcgType = "color" | "dimension" | "fontFamily" | "fontWeight" | "duration" | "cubicBezier" | "number" | "string" | "boolean";

export interface DtcgToken {
  $value: string | number | boolean;
  $type: DtcgType;
  $description?: string;
  $extensions?: Record<string, any>;
}

export interface TokenBindingEvidence {
  property: string;
  tokenPath: string;
  tokenValue: string | number | boolean;
  actualValue: string;
  matchType: "exact" | "normalized" | "alias";
  confidence: number;
}

export interface TokenDriftReport {
  axId: string;
  pageId: string;
  property: string;
  actualValue: string;
  suggestedToken: string;
  suggestedValue: string | number | boolean;
  driftDelta: number;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface DtcgExportBundle {
  version: string;
  tokens: Record<string, any>;
  metadata: {
    totalTokens: number;
    tokenTypes: Record<DtcgType, number>;
    exportedAt: string;
    generator: string;
  };
}

// ----- VI-05: Visual Regression Diffing Types -----
export type VisualRegressionSeverity = "critical" | "high" | "medium" | "low" | "none";

export type VisualRegressionDefectKind =
  | "layout-shift"
  | "dimension-change"
  | "style-drift"
  | "token-detachment"
  | "visibility-regression"
  | "pattern-degradation";

export interface VisualRegressionDefect {
  kind: VisualRegressionDefectKind;
  severity: VisualRegressionSeverity;
  property?: string;
  baselineValue?: any;
  candidateValue?: any;
  delta?: number;
  description: string;
}

export interface VisualNodeDiff {
  axId: string;
  baselineVisId?: string;
  candidateVisId?: string;
  hasRegression: boolean;
  maxSeverity: VisualRegressionSeverity;
  defects: VisualRegressionDefect[];
  layoutShiftScore: number;
}

export interface VisualRegressionReport {
  pageId: string;
  totalNodesCompared: number;
  regressedNodesCount: number;
  maxSeverity: VisualRegressionSeverity;
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    none: number;
  };
  cumulativeLayoutShift: number;
  nodeDiffs: VisualNodeDiff[];
  addedNodes: string[];
  removedNodes: string[];
  timestamp: string;
}

// ----- Graph diagnostics and telemetry telemetry -----
export interface GraphDiagnostics {
  extractorFailures: Array<{ pageId: string; extractor: string; error: string; timestamp: string }>;
  pageErrors: Array<{ url: string; error: string; status: "timeout" | "spa-error"; timestamp: string }>;
  extractionWarnings: Array<{ pageId: string; tag: string; elementId: string | null; error: string }>;
}


// ----- Top-level graph document -----
export interface GraphDocument {
  version: "1.0.0";
  crawl: {
    rootUrl: string;
    startedAt: string;
    finishedAt: string;
    browser: { engine: BrowserKind; version: string };
    pages: number;
    tokens: number;
  };
  designTokens: Record<string, any>;
  pages: PageNode[];
  axNodes: AxNode[];
  visualNodes: VisualNode[];
  navElements: NavElement[];
  edges: Edge[];
  capabilities: Capability[];
  transitions: Transition[];
  /**
   * PR-8: state nodes for the Interaction/State Graph. Each
   * `StateNode` has a canonical `payload` and an id derived from it
   * (per `deriveStateId`). State -> State edges with `triggers`
   * are stored in `edges` with `kind: "state:successor" |
   * "state:predecessor"`.
   */
  states: StateNode[];
  /**
   * PR-8c T6: auth-context nodes — one per unique AuthContext
   * observed during the crawl. `state:auth` edges reference these.
   */
  authContexts: AuthContextNode[];
  /**
   * Diagnostic telemetry tracking extraction health, failed pages, and extractor exceptions.
   */
  diagnostics?: GraphDiagnostics;

}

export type BrowserKind = "firefox" | "chrome" | "chromium" | (string & {});

// ----- Discriminated union for graph.query hits -----
export type GraphHit =
  | { select: "page"; node: PageNode }
  | { select: "ax-node"; node: AxNode }
  | { select: "visual-node"; node: VisualNode }
  | { select: "edge"; node: Edge }
  | { select: "capability"; node: Capability }
  | { select: "transition"; node: Transition }
  | { select: "nav-element"; node: NavElement }
  // PR-8: state nodes are first-class queryable graph nodes.
  | { select: "state"; node: StateNode }
  // PR-8c T6: auth-context nodes are first-class queryable graph nodes.
  | { select: "auth-context"; node: AuthContextNode };

export type AnyNode = PageNode | AxNode | VisualNode | NavElement | Edge | Capability | Transition | StateNode | AuthContextNode;

/**
 * R2 — substrate provenance: WHO produced this graph, WHEN, and with WHAT
 * content identity. Attached to a Graph by `loadFromDocument` / `GraphStore`
 * and surfaced to agents via the `substrate_info` MCP tool so that freshness
 * is provable (asserted on a computed hash), not assumed (operator claim).
 *
 * `null` on the Graph means "in-memory graph with no substrate behind it" —
 * every consumer must treat that as unattributed.
 */
export interface SubstrateProvenance {
  /** Directory the substrate was loaded from (null when in-memory). */
  outputDir: string | null;
  /** Path of the graph.json the graph was loaded from (null when in-memory). */
  graphPath: string | null;
  /** SHA-256 of the raw graph.json bytes (null when in-memory / unknown). */
  graphHash: string | null;
  /** Crawl identity restored from the document's `crawl` block. */
  crawl: {
    rootUrl: string;
    startedAt: string;
    finishedAt: string;
    browser: { engine: BrowserKind; version: string };
    pages: number;
    tokens: number;
  } | null;
  /** Frontier hash from crawl.cmeta.json, when present. */
  frontierHash: string | null;
  /** Nexus build version serving this substrate. */
  buildVersion: string;
}

