/**
 * Stage 6 — extract-visual: the visual-layer extractor (plan section 6).
 *
 * For every element matching the visual selector list, capture:
 *  - rect (`getBoundingClientRect`)
 *  - computedStyle: 35 sampled properties (plan 6.1; the cap is informal)
 *  - axId: looked up from the structural extractor's output by matching the
 *    DOM-order index; if no structural node exists, mint a new one.
 *
 * Then run the layout-relation algorithm (plan 6.2) to compute tethers:
 *  - parent / children / siblingsBefore / siblingsAfter / anchors.
 *  - DOM-parent is the primary parent (Step 1).
 *  - For `position: fixed | absolute | sticky`, walk up the DOM parent chain
 *    to the nearest non-static ancestor (or the viewport root) (Step 2).
 *  - Children = DOM children + absolutely-positioned descendants whose
 *    layout-parent is this node (Step 3).
 *  - Sibling order is by `rect.y` then `rect.x` (Step 4).
 *  - Anchors: register `anchor-name`, resolve `position-anchor` (Step 5).
 *
 * Then run token reverse-mapping (plan 6.3):
 *  - Walk `:root` and any element with explicit `--*` declarations, capture
 *    every CSS custom property and its computed value.
 *  - For every visual node's 30 computed-style values, check whether any
 *    matches a token value exactly. If yes, append the DTCG-converted path.
 *  - For non-matching color values, try `rgb-to-hex` and re-check.
 *  - For tokens, mint DTCG names via the kebab-to-dot transform.
 */
import type { Extractor } from "../crawler/orchestrator.js";
import type {
  ComputedStyleSnapshot,
  DtcgToken,
  DtcgType,
  Provenance,
  Rect,
  Tethers,
  VisualNode,
  ViewportProfile,
  ViewportObservation,
  BoxEdgeMeasurements,
  BoxModelMeasurements,
  ScrollClippingContext,
  StackingContextInfo,
  RenderBoundsInfo,
  VisualContainerType,
  OcclusionInfo,
} from "../graph/types.js";
import { DEFAULT_VIEWPORT_PROFILES } from "../graph/types.js";
import { interpretPage } from "./interpret.js";
import { computePageOcclusion } from "./occlusion.js";
import { extractSpatialEdges } from "./spatial.js";
import { classifyPageVisualPatterns } from "./patterns.js";
import { bindTokensToNode, detectTokenDrifts } from "./tokens.js";

// ============================================================================
// Provenance
// ============================================================================

/** Provenance string used for every node this extractor produces. */
export const VISUAL_PROVENANCE: Provenance = "bidi:script.callFunction";

// ============================================================================
// CSS properties (plan 6.1, VI-02)
// ============================================================================

/**
 * The CSS properties sampled per element. Covers box-model geometry, typography,
 * foreground/background colors, layout modes, scrolling, and stacking effects.
 */
export const CSS_PROPERTIES: readonly string[] = [
  // box / layout
  "display", "position", "top", "right", "bottom", "left", "z-index",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "margin", "padding", "border-radius",
  "box-sizing", "aspect-ratio",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-style", "border-color",
  // color / background
  "color", "background-color", "background-image",
  // typography
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  // effects
  "opacity", "transform", "filter", "box-shadow", "isolation", "mix-blend-mode", "will-change", "clip-path", "contain",
  // overflow / visibility
  "overflow", "overflow-x", "overflow-y", "visibility",
  // grid / flex
  "grid-template-columns", "grid-template-rows", "column-gap", "row-gap",
  "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis",
  "align-items", "justify-content", "align-content", "align-self", "justify-self",
  "gap",
  // CSS Anchor Positioning
  "anchor-name", "position-anchor",
] as const;

// ============================================================================
// In-page walker payload
// ============================================================================

/**
 * The element list sent back from the in-page walker. Each entry is the raw
 * pre-order DOM walk with computed style, rect, parent index, and the
 * structural-extractor's `axId` (or a freshly-minted one if no structural
 * node exists at this DOM order).
 */
export interface VisualElementRaw {
  /** DOM-order index (pre-order depth-first, 0-based). */
  domOrder: number;
  /** Element tag in lower case (e.g. "button"). */
  tag: string;
  /** Element id attribute, or null. */
  elementId: string | null;
  /** axId from the structural extractor (or freshly minted). */
  axId: string;
  /** axId of the DOM parent, or null if this is the document root. */
  parentAxId: string | null;
  /** `getBoundingClientRect` result. */
  rect: Rect;
  /** The sampled computed-style values. */
  computedStyle: ComputedStyleSnapshot;
  /** Explicit CSS custom properties declared on this element (key, computed value). */
  customProperties: Array<{ name: string; value: string }>;
  /** VI-02: Visual container / layout wrapper classification. */
  isVisualContainer?: boolean;
  containerType?: VisualContainerType;
  /** VI-02: Complete CSS box-model geometry measurements. */
  boxModel?: BoxModelMeasurements;
  /** VI-02: Scroll and clipping context. */
  scrollClippingContext?: ScrollClippingContext;
  /** VI-02: Stacking context and paint order. */
  stackingContext?: StackingContextInfo;
  /** VI-02: Layout vs transformed render bounds. */
  renderBounds?: RenderBoundsInfo;
}

/** Top-level response from the in-page visual walker. */
export interface VisualWalkResult {
  elements: VisualElementRaw[];
  /** CSS custom properties found on `:root` (and key elements), in source order. */
  rootCustomProperties: Array<{ name: string; value: string }>;
}

// ============================================================================
// Pure layout calculation helpers (VI-02)
// ============================================================================

function parsePixels(val: string | undefined | null, fallback = 0): number {
  if (val == null) return fallback;
  const parsed = parseFloat(String(val));
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * VI-02: Pure helper to compute complete box model geometry metrics from rect and computed styles.
 */
export function computeBoxModel(
  rect: Rect,
  computedStyle: ComputedStyleSnapshot,
): BoxModelMeasurements {
  const topM = parsePixels(computedStyle["margin-top"] ?? computedStyle.marginTop);
  const rightM = parsePixels(computedStyle["margin-right"] ?? computedStyle.marginRight);
  const bottomM = parsePixels(computedStyle["margin-bottom"] ?? computedStyle.marginBottom);
  const leftM = parsePixels(computedStyle["margin-left"] ?? computedStyle.marginLeft);

  const topB = parsePixels(computedStyle["border-top-width"] ?? computedStyle.borderTopWidth);
  const rightB = parsePixels(computedStyle["border-right-width"] ?? computedStyle.borderRightWidth);
  const bottomB = parsePixels(computedStyle["border-bottom-width"] ?? computedStyle.borderBottomWidth);
  const leftB = parsePixels(computedStyle["border-left-width"] ?? computedStyle.borderLeftWidth);

  const topP = parsePixels(computedStyle["padding-top"] ?? computedStyle.paddingTop);
  const rightP = parsePixels(computedStyle["padding-right"] ?? computedStyle.paddingRight);
  const bottomP = parsePixels(computedStyle["padding-bottom"] ?? computedStyle.paddingBottom);
  const leftP = parsePixels(computedStyle["padding-left"] ?? computedStyle.paddingLeft);

  const borderBox: Rect = {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
  };

  const paddingBox: Rect = {
    x: borderBox.x + leftB,
    y: borderBox.y + topB,
    w: Math.max(0, borderBox.w - leftB - rightB),
    h: Math.max(0, borderBox.h - topB - bottomB),
  };

  const contentBox: Rect = {
    x: paddingBox.x + leftP,
    y: paddingBox.y + topP,
    w: Math.max(0, paddingBox.w - leftP - rightP),
    h: Math.max(0, paddingBox.h - topP - bottomP),
  };

  const marginBox: Rect = {
    x: borderBox.x - leftM,
    y: borderBox.y - topM,
    w: borderBox.w + leftM + rightM,
    h: borderBox.h + topM + bottomM,
  };

  const boxSizing = computedStyle["box-sizing"] ?? computedStyle.boxSizing ?? "content-box";

  return {
    content: contentBox,
    padding: { top: topP, right: rightP, bottom: bottomP, left: leftP },
    border: { top: topB, right: rightB, bottom: bottomB, left: leftB },
    margin: { top: topM, right: rightM, bottom: bottomM, left: leftM },
    paddingBox,
    borderBox,
    marginBox,
    boxSizing,
  };
}

/**
 * VI-02: Pure helper to compute stacking context triggers and resolved z-index.
 */
export function computeStackingContext(
  computedStyle: ComputedStyleSnapshot,
  isRoot = false,
  stackingParentAxId: string | null = null,
): StackingContextInfo {
  const reasons: string[] = [];
  if (isRoot) {
    reasons.push("root");
  }

  const pos = computedStyle.position ?? "static";
  const rawZ = computedStyle["z-index"] ?? computedStyle.zIndex;
  const zParsed = parseInt(String(rawZ), 10);
  const hasZ = !Number.isNaN(zParsed) && rawZ !== "auto";

  if ((pos === "relative" || pos === "absolute") && hasZ) {
    reasons.push(`position:${pos} z-index:${zParsed}`);
  }
  if (pos === "fixed" || pos === "sticky") {
    reasons.push(`position:${pos}`);
  }

  const op = parseFloat(computedStyle.opacity ?? "1");
  if (!Number.isNaN(op) && op < 1) {
    reasons.push(`opacity:${op}`);
  }

  const tr = computedStyle.transform;
  if (tr && tr !== "none") {
    reasons.push("transform");
  }

  const fl = computedStyle.filter;
  if (fl && fl !== "none") {
    reasons.push("filter");
  }

  const iso = computedStyle.isolation;
  if (iso === "isolate") {
    reasons.push("isolation:isolate");
  }

  const blend = computedStyle["mix-blend-mode"] ?? computedStyle.mixBlendMode;
  if (blend && blend !== "normal") {
    reasons.push(`mix-blend-mode:${blend}`);
  }

  const contain = computedStyle.contain ?? "";
  if (
    contain.includes("paint") ||
    contain.includes("layout") ||
    contain.includes("strict") ||
    contain.includes("content")
  ) {
    reasons.push(`contain:${contain}`);
  }

  const cp = computedStyle["clip-path"] ?? computedStyle.clipPath;
  if (cp && cp !== "none") {
    reasons.push("clip-path");
  }

  const willChange = computedStyle["will-change"] ?? computedStyle.willChange ?? "";
  if (
    willChange.includes("transform") ||
    willChange.includes("opacity") ||
    willChange.includes("filter")
  ) {
    reasons.push(`will-change:${willChange}`);
  }

  return {
    isStackingContext: reasons.length > 0,
    zIndex: hasZ ? zParsed : "auto",
    reasons,
    stackingParentAxId,
  };
}
/**
 * VI-02: Pure helper to compute scroll container and clipping properties.
 */
export function computeScrollClippingContext(
  scrollMetrics: {
    scrollWidth: number;
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
    clientWidth: number;
    clientHeight: number;
  },
  computedStyle: ComputedStyleSnapshot,
  scrollContainerAxId: string | null = null,
): ScrollClippingContext {
  const ox = computedStyle["overflow-x"] ?? computedStyle.overflowX ?? computedStyle.overflow ?? "visible";
  const oy = computedStyle["overflow-y"] ?? computedStyle.overflowY ?? computedStyle.overflow ?? "visible";
  const isScrollDecl = ox === "scroll" || ox === "auto" || oy === "scroll" || oy === "auto";
  const canScrollX = scrollMetrics.scrollWidth > scrollMetrics.clientWidth + 1;
  const canScrollY = scrollMetrics.scrollHeight > scrollMetrics.clientHeight + 1;
  const cp = computedStyle["clip-path"] ?? computedStyle.clipPath;
  const isClipped = ox !== "visible" || oy !== "visible" || Boolean(cp && cp !== "none");

  return {
    isScrollContainer: isScrollDecl || canScrollX || canScrollY,
    canScrollX,
    canScrollY,
    scrollWidth: scrollMetrics.scrollWidth,
    scrollHeight: scrollMetrics.scrollHeight,
    scrollLeft: scrollMetrics.scrollLeft,
    scrollTop: scrollMetrics.scrollTop,
    isClipped,
    overflowX: ox,
    overflowY: oy,
    clipPath: cp && cp !== "none" ? cp : null,
    scrollContainerAxId,
  };
}

/**
 * VI-02: Pure helper to classify visual container / wrapper types.
 */
export function classifyVisualContainer(
  element: { tag?: string; elementId?: string | null; className?: string; childCount?: number; rect?: Rect },
  computedStyle: ComputedStyleSnapshot,
  boxModel?: BoxModelMeasurements,
  scrollContext?: ScrollClippingContext,
): { isVisualContainer: boolean; containerType: VisualContainerType } {
  const d = computedStyle.display ?? "block";
  const isGrid = d === "grid" || d === "inline-grid";
  const isFlex = d === "flex" || d === "inline-flex";

  const cls = (element.className ?? "").toLowerCase();
  const id = (element.elementId ?? "").toLowerCase();
  const tag = (element.tag ?? "div").toLowerCase();
  const rect = element.rect ?? { x: 0, y: 0, w: 0, h: 0 };

  const bg = computedStyle.backgroundColor ?? "";
  const hasBg = Boolean(bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)");
  const hasBgImage = Boolean(computedStyle.backgroundImage && computedStyle.backgroundImage !== "none");

  const border = boxModel?.border ?? {
    top: parsePixels(computedStyle["border-top-width"] ?? computedStyle.borderTopWidth),
    right: parsePixels(computedStyle["border-right-width"] ?? computedStyle.borderRightWidth),
    bottom: parsePixels(computedStyle["border-bottom-width"] ?? computedStyle.borderBottomWidth),
    left: parsePixels(computedStyle["border-left-width"] ?? computedStyle.borderLeftWidth),
  };
  const hasBorder = (border.top > 0 || border.right > 0 || border.bottom > 0 || border.left > 0) &&
    (computedStyle.borderStyle ?? computedStyle["border-style"]) !== "none";

  const shadow = computedStyle["box-shadow"] ?? computedStyle.boxShadow;
  const hasShadow = Boolean(shadow && shadow !== "none");
  const radius = parsePixels(computedStyle["border-radius"] ?? computedStyle.borderRadius);
  const hasRadius = radius > 0;

  const hasHeroIndicator = cls.includes("hero") || id.includes("hero") ||
    cls.includes("banner") || id.includes("banner") ||
    (tag === "header" && rect.h > 150);

  const hasCardIndicator = cls.includes("card") || id.includes("card") ||
    (hasBorder && hasRadius) || (hasShadow && (hasBg || hasBorder));

  if (isGrid) {
    return { isVisualContainer: true, containerType: "grid" };
  }
  if (isFlex) {
    return { isVisualContainer: true, containerType: "flex" };
  }
  if (hasHeroIndicator && (rect.w > 200 || rect.h > 100)) {
    return { isVisualContainer: true, containerType: "hero" };
  }
  if (hasCardIndicator && (rect.w > 80 && rect.h > 60)) {
    return { isVisualContainer: true, containerType: "card" };
  }
  if (["section", "article", "main", "aside", "nav", "header", "footer"].includes(tag)) {
    return { isVisualContainer: true, containerType: "section" };
  }
  if (scrollContext?.isScrollContainer) {
    return { isVisualContainer: true, containerType: "scroll" };
  }
  if ((hasBg || hasBgImage || hasBorder || hasShadow) && rect.w > 40 && rect.h > 40) {
    return { isVisualContainer: true, containerType: "container" };
  }
  if ((element.childCount ?? 0) >= 2 && rect.w > 50 && rect.h > 20) {
    return { isVisualContainer: true, containerType: "wrapper" };
  }

  return { isVisualContainer: false, containerType: "none" };
}

/**
 * VI-02: Pure helper to compute rendered bounds comparing post-transform to pre-transform layout.
 */
export function computeRenderBounds(
  rect: Rect,
  layoutRect: Rect,
  computedStyle: ComputedStyleSnapshot,
): RenderBoundsInfo {
  const tr = computedStyle.transform ?? null;
  const hasTransform = Boolean(tr && tr !== "none");
  return {
    transformed: rect,
    layout: layoutRect,
    hasTransform,
    transform: hasTransform ? tr : null,
  };
}


// ============================================================================
// In-page walker
// ============================================================================

/**
 * The function declaration that runs in the page. It MUST be self-contained:
 * no closures, no module imports, no `import` statements. The BiDi transport
 * serializes it verbatim into the target realm.
 *
 * Walk strategy:
 *   1. Pre-order DOM walk via TreeWalker(NodeFilter.SHOW_ELEMENT) so the
 *      `domOrder` matches the structural extractor's pre-order and axIds
 *      can be aligned.
 *   2. Mint axId using the structural strategy: `ax:<pageId>:<elementId>` if
 *      the element has an id, else `ax:<pageId>:n<domOrder>`. A counter
 *      tracks minted ids for elements with no id so siblings with the same
 *      `n<domOrder>` slot do not collide.
 *   3. Capture `getBoundingClientRect` and the 35 CSS properties.
 *   4. Capture explicit `style` `--*` declarations; the TS side then
 *      re-resolves their computed values via `getComputedStyle(el).getPropertyValue`.
 *      We send the raw declaration value here and the TS side does the
 *      computed-value resolution via a second small `getPropertyValue`
 *      pass — keeps the walker payload compact.
 *
 * The walker accepts one arg: `pageId` (e.g. "page:https://example.com/").
 */
export const VISUAL_WALKER_FN = `(pageId) => {
  const SEMANTIC_SEL = '[role],button,a,input,select,textarea,h1,h2,h3,h4,h5,h6,nav,main,aside,header,footer,form,dialog,table,fieldset,section,article,figure,[data-ax]';
  const SAMPLED = ${JSON.stringify(CSS_PROPERTIES)};

  const idxOf = new Map();
  {
    const root = document.documentElement;
    idxOf.set(root, 0);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let n; let i = 1;
    while ((n = walker.nextNode())) { idxOf.set(n, i); i++; }
  }

  function mintAxId(el) {
    if (el.id) return 'ax:' + pageId + ':' + el.id;
    const idx = idxOf.get(el);
    if (idx === undefined) {
      const parent = el.parentElement;
      let sibIdx = 0;
      if (parent) for (let s = el.previousElementSibling; s; s = s.previousElementSibling) sibIdx++;
      return 'ax:' + pageId + ':dyn:' + (el.tagName || '') + ':' + sibIdx;
    }
    return 'ax:' + pageId + ':n' + idx;
  }

  function parsePx(val) {
    if (!val) return 0;
    const p = parseFloat(val);
    return isNaN(p) ? 0 : p;
  }

  const allEls = document.querySelectorAll('*');
  const candidates = [];

  for (let i = 0; i < allEls.length; i++) {
    const el = allEls[i];
    const tag = el.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'HEAD' || tag === 'TITLE' || tag === 'META' || tag === 'LINK' || tag === 'BR' || tag === 'WBR') {
      continue;
    }

    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    const isZero = r.width === 0 && r.height === 0;
    const isHidden = cs.display === 'none' || cs.visibility === 'hidden';
    const isSemantic = el.matches(SEMANTIC_SEL);

    if (isZero && !isSemantic) continue;
    if (isHidden && !isSemantic) continue;

    const d = cs.display || '';
    const isGrid = d === 'grid' || d === 'inline-grid';
    const isFlex = d === 'flex' || d === 'inline-flex';
    const ox = cs.overflowX || cs.overflow || 'visible';
    const oy = cs.overflowY || cs.overflow || 'visible';
    const isScroll = ox === 'scroll' || ox === 'auto' || oy === 'scroll' || oy === 'auto';
    const pos = cs.position || 'static';
    const isPos = pos === 'fixed' || pos === 'sticky';
    const tr = cs.transform;
    const hasTr = Boolean(tr && tr !== 'none');
    const bg = cs.backgroundColor;
    const hasBg = Boolean(bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)');
    const hasBgImg = Boolean(cs.backgroundImage && cs.backgroundImage !== 'none');
    const hasBorder = (parsePx(cs.borderTopWidth) > 0 || parsePx(cs.borderRightWidth) > 0 || parsePx(cs.borderBottomWidth) > 0 || parsePx(cs.borderLeftWidth) > 0) && cs.borderStyle !== 'none';
    const hasShadow = Boolean(cs.boxShadow && cs.boxShadow !== 'none');

    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const hasLayoutIndicator = cls.indexOf('hero') !== -1 || id.indexOf('hero') !== -1 ||
                               cls.indexOf('banner') !== -1 || id.indexOf('banner') !== -1 ||
                               cls.indexOf('card') !== -1 || id.indexOf('card') !== -1 ||
                               cls.indexOf('container') !== -1 || id.indexOf('container') !== -1 ||
                               cls.indexOf('wrapper') !== -1 || id.indexOf('wrapper') !== -1 ||
                               cls.indexOf('grid') !== -1 || cls.indexOf('flex') !== -1;

    let shouldInclude = isSemantic || isGrid || isFlex || isScroll || isPos || hasTr;
    if (!shouldInclude && hasLayoutIndicator && (r.width > 20 || r.height > 20)) shouldInclude = true;
    if (!shouldInclude && (hasBg || hasBgImg || hasBorder || hasShadow) && r.width > 40 && r.height > 40) shouldInclude = true;
    if (!shouldInclude && parsePx(cs.borderRadius) > 0 && (hasBg || hasBorder) && r.width > 20 && r.height > 20) shouldInclude = true;

    if (shouldInclude) {
      candidates.push({ el, cs, r });
    }
  }

  const matchSet = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    matchSet.add(c.el);
    c.axId = mintAxId(c.el);
    c.el.__axId = c.axId;
  }
  function getBoxModel(r, cs) {
    const tm = parsePx(cs.marginTop), rm = parsePx(cs.marginRight), bm = parsePx(cs.marginBottom), lm = parsePx(cs.marginLeft);
    const tb = parsePx(cs.borderTopWidth), rb = parsePx(cs.borderRightWidth), bb = parsePx(cs.borderBottomWidth), lb = parsePx(cs.borderLeftWidth);
    const tp = parsePx(cs.paddingTop), rp = parsePx(cs.paddingRight), bp = parsePx(cs.paddingBottom), lp = parsePx(cs.paddingLeft);
    const borderBox = { x: r.left, y: r.top, w: r.width, h: r.height };
    const paddingBox = { x: borderBox.x + lb, y: borderBox.y + tb, w: Math.max(0, borderBox.w - lb - rb), h: Math.max(0, borderBox.h - tb - bb) };
    const contentBox = { x: paddingBox.x + lp, y: paddingBox.y + tp, w: Math.max(0, paddingBox.w - lp - rp), h: Math.max(0, paddingBox.h - tp - bp) };
    const marginBox = { x: borderBox.x - lm, y: borderBox.y - tm, w: borderBox.w + lm + rm, h: borderBox.h + tm + bm };
    return {
      content: contentBox,
      padding: { top: tp, right: rp, bottom: bp, left: lp },
      border: { top: tb, right: rb, bottom: bb, left: lb },
      margin: { top: tm, right: rm, bottom: bm, left: lm },
      paddingBox: paddingBox, borderBox: borderBox, marginBox: marginBox,
      boxSizing: cs.boxSizing || 'content-box',
    };
  }
  function getScrollAndStacking(el, cs, matchSet, mintAxId) {
    let p = el.parentElement;
    let parentAxId = null, scrollContainerAxId = null, stackingParentAxId = null;
    while (p) {
      if (matchSet.has(p)) {
        if (!parentAxId) parentAxId = p.__axId || mintAxId(p);
        const pcs = getComputedStyle(p);
        const pox = pcs.overflowX || pcs.overflow || 'visible', poy = pcs.overflowY || pcs.overflow || 'visible';
        if (!scrollContainerAxId && (pox === 'scroll' || pox === 'auto' || poy === 'scroll' || poy === 'auto' || p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1)) {
          scrollContainerAxId = p.__axId || mintAxId(p);
        }
        const ppos = pcs.position || 'static', pz = parseInt(pcs.zIndex, 10), phasZ = !isNaN(pz) && pcs.zIndex !== 'auto', pop = parseFloat(pcs.opacity), ptr = pcs.transform;
        if (!stackingParentAxId && (p === document.documentElement || (ppos !== 'static' && phasZ) || ppos === 'fixed' || ppos === 'sticky' || (!isNaN(pop) && pop < 1) || (ptr && ptr !== 'none') || pcs.isolation === 'isolate')) {
          stackingParentAxId = p.__axId || mintAxId(p);
        }
      }
      p = p.parentElement;
    }
    const ox = cs.overflowX || cs.overflow || 'visible', oy = cs.overflowY || cs.overflow || 'visible';
    const isScrollDecl = ox === 'scroll' || ox === 'auto' || oy === 'scroll' || oy === 'auto';
    const canScrollX = el.scrollWidth > (el.clientWidth + 1), canScrollY = el.scrollHeight > (el.clientHeight + 1);
    const isClipped = ox !== 'visible' || oy !== 'visible' || Boolean(cs.clipPath && cs.clipPath !== 'none');
    const scrollContext = {
      isScrollContainer: Boolean(isScrollDecl || canScrollX || canScrollY),
      canScrollX: canScrollX, canScrollY: canScrollY,
      scrollWidth: el.scrollWidth || 0, scrollHeight: el.scrollHeight || 0,
      scrollLeft: el.scrollLeft || 0, scrollTop: el.scrollTop || 0,
      isClipped: isClipped, overflowX: ox, overflowY: oy,
      clipPath: cs.clipPath && cs.clipPath !== 'none' ? cs.clipPath : null,
      scrollContainerAxId: scrollContainerAxId,
    };
    const reasons = [];
    if (el === document.documentElement) reasons.push('root');
    const pos = cs.position || 'static', zParsed = parseInt(cs.zIndex, 10), hasZ = !isNaN(zParsed) && cs.zIndex !== 'auto';
    if ((pos === 'relative' || pos === 'absolute') && hasZ) reasons.push('position:' + pos + ' z-index:' + zParsed);
    if (pos === 'fixed' || pos === 'sticky') reasons.push('position:' + pos);
    const op = parseFloat(cs.opacity);
    if (!isNaN(op) && op < 1) reasons.push('opacity:' + op);
    if (cs.transform && cs.transform !== 'none') reasons.push('transform');
    if (cs.filter && cs.filter !== 'none') reasons.push('filter');
    if (cs.isolation === 'isolate') reasons.push('isolation:isolate');
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') reasons.push('mix-blend-mode:' + cs.mixBlendMode);
    if (cs.contain && (cs.contain.indexOf('paint') !== -1 || cs.contain.indexOf('layout') !== -1 || cs.contain.indexOf('strict') !== -1 || cs.contain.indexOf('content') !== -1)) reasons.push('contain:' + cs.contain);
    if (cs.clipPath && cs.clipPath !== 'none') reasons.push('clip-path');
    if (cs.willChange && (cs.willChange.indexOf('transform') !== -1 || cs.willChange.indexOf('opacity') !== -1 || cs.willChange.indexOf('filter') !== -1)) reasons.push('will-change:' + cs.willChange);
    const stackingContext = {
      isStackingContext: reasons.length > 0, zIndex: hasZ ? zParsed : 'auto', reasons: reasons, stackingParentAxId: stackingParentAxId,
    };
    return { parentAxId, scrollContext, stackingContext };
  }



  const out = [];
  let domOrder = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const el = c.el, cs = c.cs, r = c.r, axId = c.axId;
    const { parentAxId, scrollContext, stackingContext } = getScrollAndStacking(el, cs, matchSet, mintAxId);

    const style = {};
    for (let j = 0; j < SAMPLED.length; j++) {
      const prop = SAMPLED[j];
      let v = cs.getPropertyValue(prop);
      if (v === '') v = null;
      style[prop] = v;
    }

    const customProperties = [];
    if (el.style && el.style.length) {
      for (let j = 0; j < el.style.length; j++) {
        const name = el.style[j];
        if (name && name.startsWith('--')) {
          customProperties.push({ name: name, value: el.style.getPropertyValue(name) });
        }
      }
    }

    const boxModel = getBoxModel(r, cs);
    const borderBox = boxModel.borderBox;
    const tr = cs.transform, hasTr = Boolean(tr && tr !== 'none');
    // ED-10 §6 defect 2 — the ROOT CAUSE of the 2026-09-16 ledger failure:
    // boxModel.borderBox is re-used below as 'rect' and as
    // renderBounds.transformed. WebDriver BiDi serializes a repeated object
    // reference as a value-less {type:"object",internalId} back-reference
    // (verified by probe 2b: 2 back-references per element x 44 elements =
    // the 88 the wire tap measured). Clone at every payload placement so the
    // payload is a plain tree with no shared references.
    const rectOut = { x: borderBox.x, y: borderBox.y, w: borderBox.w, h: borderBox.h };
    const renderBounds = {
      transformed: { x: borderBox.x, y: borderBox.y, w: borderBox.w, h: borderBox.h },
      layout: {
        x: el.offsetLeft !== undefined ? el.offsetLeft : borderBox.x,
        y: el.offsetTop !== undefined ? el.offsetTop : borderBox.y,
        w: el.offsetWidth !== undefined ? el.offsetWidth : borderBox.w,
        h: el.offsetHeight !== undefined ? el.offsetHeight : borderBox.h,
      },
      hasTransform: hasTr,
      transform: hasTr ? tr : null,
    };

    let isVisualContainer = false, containerType = 'none';
    const d = cs.display || 'block', isGrid = d === 'grid' || d === 'inline-grid', isFlex = d === 'flex' || d === 'inline-flex';
    const tag = el.tagName.toLowerCase(), cls = (typeof el.className === 'string' ? el.className : '').toLowerCase(), id = (el.id || '').toLowerCase();
    const bg = cs.backgroundColor, hasBg = Boolean(bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)');
    const hasBgImage = Boolean(cs.backgroundImage && cs.backgroundImage !== 'none');
    const hasBorder = Boolean((boxModel.border.top > 0 || boxModel.border.right > 0 || boxModel.border.bottom > 0 || boxModel.border.left > 0) && cs.borderStyle !== 'none');
    const hasShadow = Boolean(cs.boxShadow && cs.boxShadow !== 'none');
    const hasHeroIndicator = cls.indexOf('hero') !== -1 || id.indexOf('hero') !== -1 || cls.indexOf('banner') !== -1 || id.indexOf('banner') !== -1 || (tag === 'header' && borderBox.h > 150);
    const hasCardIndicator = cls.indexOf('card') !== -1 || id.indexOf('card') !== -1 || (hasBorder && parsePx(cs.borderRadius) > 0) || (hasShadow && (hasBg || hasBorder));

    if (isGrid) {
      isVisualContainer = true; containerType = 'grid';
    } else if (isFlex) {
      isVisualContainer = true; containerType = 'flex';
    } else if (hasHeroIndicator && (borderBox.w > 200 || borderBox.h > 100)) {
      isVisualContainer = true; containerType = 'hero';
    } else if (hasCardIndicator && (borderBox.w > 80 && borderBox.h > 60)) {
      isVisualContainer = true; containerType = 'card';
    } else if (tag === 'section' || tag === 'article' || tag === 'main' || tag === 'aside' || tag === 'nav' || tag === 'header' || tag === 'footer') {
      isVisualContainer = true; containerType = 'section';
    } else if (scrollContext.isScrollContainer) {
      isVisualContainer = true; containerType = 'scroll';
    } else if ((hasBg || hasBgImage || hasBorder || hasShadow) && borderBox.w > 40 && borderBox.h > 40) {
      isVisualContainer = true; containerType = 'container';
    } else if (el.childElementCount >= 2 && borderBox.w > 50 && borderBox.h > 20) {
      isVisualContainer = true; containerType = 'wrapper';
    }

    out.push({
      domOrder: domOrder++,
      tag: tag,
      elementId: el.id || null,
      axId: axId,
      parentAxId: parentAxId,
      rect: rectOut,
      computedStyle: style,
      customProperties: customProperties,
      isVisualContainer: isVisualContainer,
      containerType: containerType,
      boxModel: boxModel,
      scrollClippingContext: scrollContext,
      stackingContext: stackingContext,
      renderBounds: renderBounds,
    });
  }

  // Root custom properties — all --* on :root and explicit --* on every element.
  const rootCs = getComputedStyle(document.documentElement);
  const rootCustomProperties = [];
  // CSS variables are exposed on the CSSStyleDeclaration of :root with names
  // starting with "--". We iterate via a per-property scan.
  // The :root computed style is huge; we use a sentinel "all variable names"
  // walk by enumerating cascaded rules, then a per-element :root walk.
  // Simpler: read from the inline style of :root + recursively walk children
  // for elements that declare --* (already collected in customProperties).
  if (document.documentElement.style.length) {
    for (let i = 0; i < document.documentElement.style.length; i++) {
      const name = document.documentElement.style[i];
      if (name && name.startsWith('--')) {
        const value = rootCs.getPropertyValue(name).trim();
        if (value) rootCustomProperties.push({ name, value });
      }
    }
  }
  // Also enumerate :root's computed --* from its cascaded declarations by
  // walking all rules — fallback: scan all elements for any --* that resolves
  // on :root (the typical case for token systems).
  // We rely on a separate token-walker pass for the full enumeration; this
  // field carries what we found inline on :root only.

  return {
    elements: out,
    rootCustomProperties: rootCustomProperties,
  };
}`;

// ============================================================================
// Token walker — fuller enumeration of --* declarations
// ============================================================================

/**
 * Second-pass walker: enumerate every CSS custom property declared anywhere
 * in the document and its computed value at `:root`. Plan 6.3 step 1: walk
 * `:root` and any element with explicit `--*` declarations.
 *
 * Returns the deduplicated list of (name, computedValue) pairs.
 */
export const TOKEN_WALKER_FN = `(_arg) => {
  const out = [];
  const seen = new Set();
  function add(name, value) {
    if (!name || !name.startsWith('--')) return;
    if (seen.has(name)) return;
    if (!value) return;
    seen.add(name);
    out.push({ name, value: String(value).trim() });
  }
  // 1. Every :root inline + cascaded --* is in getComputedStyle(documentElement).
  // The CSSStyleDeclaration of :root exposes every defined custom property
  // (even if declared in a stylesheet) as a getter. Enumerate via a scan
  // of all rules: use document.styleSheets (CORS-safe in same-origin).
  const rootCs = getComputedStyle(document.documentElement);
  // Walk all stylesheet rules; for each declaration of name starting with --,
  // read its computed value at :root.
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (!rule || !rule.style) continue;
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style[i];
          if (name && name.startsWith('--')) {
            const v = rootCs.getPropertyValue(name).trim();
            add(name, v);
          }
        }
        // Recurse into nested groups (@media, @supports, etc.) — flat walk.
        if (rule.cssRules) {
          for (const sub of Array.from(rule.cssRules)) {
            if (!sub || !sub.style) continue;
            for (let i = 0; i < sub.style.length; i++) {
              const name = sub.style[i];
              if (name && name.startsWith('--')) {
                const v = rootCs.getPropertyValue(name).trim();
                add(name, v);
              }
            }
          }
        }
      }
    }
  } catch { /* CORS or other — best-effort */ }
  // 2. Inline :root styles (in case stylesheet walk missed them).
  if (document.documentElement.style.length) {
    for (let i = 0; i < document.documentElement.style.length; i++) {
      const name = document.documentElement.style[i];
      if (name && name.startsWith('--')) {
        const v = rootCs.getPropertyValue(name).trim();
        add(name, v);
      }
    }
  }
  return out;
}`;

// ============================================================================
// Pure helpers
// ============================================================================

/** Convert a kebab-case CSS custom property name to a DTCG dot path. */
export function kebabToDtcg(name: string): string {
  return name.replace(/^--/, "").replace(/-/g, ".");
}

/** Best-effort `rgb(...)` / `rgba(...)` to hex. Returns the input unchanged on mismatch. */
export function rgbToHex(value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Already hex?
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed.toLowerCase();
  // rgb(r, g, b) or rgba(r, g, b, a) — channels may include a leading minus.
  const m = trimmed.match(/^rgba?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/);
  if (!m) return null;
  const r = clampByte(Number(m[1]));
  const g = clampByte(Number(m[2]));
  const b = clampByte(Number(m[3]));
  return "#" + [r, g, b].map(toHex2).join("");
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}

function toHex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** Heuristic DTCG type guess from a string value. */
export function guessDtcgType(value: string): DtcgType {
  const v = value.trim();
  if (!v) return "string";
  // hex color or rgb()
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return "color";
  if (/^rgba?\(/i.test(v)) return "color";
  if (/^hsla?\(/i.test(v)) return "color";
  if (colorNameSet.has(v.toLowerCase())) return "color";
  // font-size, line-height, padding, margin, etc. -> dimension
  if (/^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|vmin|vmax|pt|pc|in|cm|mm|ex|ch)$/.test(v)) return "dimension";
  if (/^var\(/.test(v)) return "string"; // unresolved var, we still record
  // font-family names
  if (/^[a-zA-Z][\w-]*$/.test(v) && v.length < 32) return "string";
  return "string";
}

/** A small but useful set of CSS color names that the demo uses. */
const colorNameSet = new Set([
  "transparent", "currentcolor", "black", "white", "red", "green", "blue",
  "yellow", "cyan", "magenta", "gray", "grey", "orange", "purple", "pink",
  "brown", "navy", "teal", "lime", "maroon", "olive", "silver", "aqua",
  "fuchsia",
]);

// ============================================================================
// Layout-relation algorithm (plan 6.2) — pure TS
// ============================================================================

/**
 * Compute the tether relations for every visual element.
 *
 * @param elements All visual elements, in DOM order, with parentAxId set.
 * @returns A Map from axId to a Tethers record.
 */
export function computeTethers(elements: VisualElementRaw[]): Map<string, Tethers> {
  // Build by-axId lookup and by-DOM-parent grouping.
  const byAxId = new Map<string, VisualElementRaw>();
  for (const el of elements) byAxId.set(el.axId, el);

  // layoutParent: where the layout tree re-parents an element (Step 2).
  // Returns the axId of the layout parent, or null if root.
  function layoutParentOf(el: VisualElementRaw): string | null {
    const pos = el.computedStyle.position ?? "static";
    if (pos !== "fixed" && pos !== "absolute" && pos !== "sticky") {
      return el.parentAxId; // Step 1: DOM parent.
    }
    // If `position-anchor` is set, the layout parent is the anchored element.
    // (The plan notes this; we honor it after the static walk so anchored
    // elements still pick up a layout parent if the anchor resolves.)
    // Walk up the DOM parent chain to the nearest non-static ancestor.
    let cur: VisualElementRaw | undefined = el;
    let parentAx = el.parentAxId;
    while (parentAx) {
      const p = byAxId.get(parentAx);
      if (!p) break;
      const ppos = p.computedStyle.position ?? "static";
      if (ppos !== "static") {
        return p.axId;
      }
      cur = p;
      parentAx = p.parentAxId;
    }
    // No non-static ancestor: viewport root. We represent "viewport" with null.
    return null;
  }

  // Children: DOM children + absolutely-positioned descendants whose
  // layout-parent is this element.
  // We compute this by walking every element and asking "who is my layout
  // parent?" — then grouping by that parent.
  const layoutParentByAxId = new Map<string, string | null>();
  for (const el of elements) {
    layoutParentByAxId.set(el.axId, layoutParentOf(el));
  }

  // Children index: parentAxId -> child axIds.
  const childrenByParent = new Map<string | null, string[]>();
  for (const el of elements) {
    const lp = layoutParentByAxId.get(el.axId) ?? null;
    let arr = childrenByParent.get(lp);
    if (!arr) { arr = []; childrenByParent.set(lp, arr); }
    arr.push(el.axId);
  }

  // Sibling groups: group by (effective parent). For each group, sort by
  // rect.y then rect.x and split into siblingsBefore/After.
  const siblingsBeforeByAxId = new Map<string, string[]>();
  const siblingsAfterByAxId = new Map<string, string[]>();
  for (const [, kids] of childrenByParent) {
    // Sort by rect.y ascending, then rect.x ascending.
    const sorted = [...kids].sort((a, b) => {
      const ea = byAxId.get(a)!;
      const eb = byAxId.get(b)!;
      if (ea.rect.y !== eb.rect.y) return ea.rect.y - eb.rect.y;
      return ea.rect.x - eb.rect.x;
    });
    for (let i = 0; i < sorted.length; i++) {
      const id = sorted[i]!;
      const before = sorted.slice(0, i);
      const after = sorted.slice(i + 1);
      siblingsBeforeByAxId.set(id, before);
      siblingsAfterByAxId.set(id, after);
    }
  }

  // Anchors: register every `anchor-name`, resolve every `position-anchor`.
  const anchorByName = new Map<string, string>(); // name -> axId
  for (const el of elements) {
    const an = (el.computedStyle["anchor-name"] ?? "").trim();
    if (an) {
      // anchor-name accepts a comma-separated list. Trim and dedup.
      for (const part of an.split(",").map((s) => s.trim()).filter(Boolean)) {
        anchorByName.set(part, el.axId);
      }
    }
  }

  // Build the result.
  const result = new Map<string, Tethers>();
  for (const el of elements) {
    const lp = layoutParentByAxId.get(el.axId) ?? null;
    const children = (childrenByParent.get(el.axId) ?? []).slice();
    const siblingsBefore = (siblingsBeforeByAxId.get(el.axId) ?? []).slice();
    const siblingsAfter = (siblingsAfterByAxId.get(el.axId) ?? []).slice();
    // Anchors from `position-anchor`.
    const anchors: Array<{ name: string; target: string }> = [];
    const pa = (el.computedStyle["position-anchor"] ?? "").trim();
    if (pa) {
      for (const part of pa.split(",").map((s) => s.trim()).filter(Boolean)) {
        const target = anchorByName.get(part);
        if (target) {
          anchors.push({ name: part, target });
        }
        // If the target doesn't resolve, drop it (plan 6.2 step 5: unresolved
        // anchors have a null target; we omit rather than emit null).
      }
    }
    result.set(el.axId, {
      parent: lp,
      children,
      siblingsBefore,
      siblingsAfter,
      anchors,
    });
  }
  return result;
}

// ============================================================================
// Token reverse-mapping (plan 6.3) — pure TS
// ============================================================================

/**
 * Compute design-token references for a visual node's computed-style values.
 *
 * For each (propertyName, value) pair in the computed-style snapshot, check
 * the token map for a value match. If found, append the DTCG-converted
 * token path to the refs list.
 *
 * For non-matching color values, try `rgb-to-hex` and re-check.
 */
export function matchTokenRefs(
  computedStyle: ComputedStyleSnapshot,
  tokenIndex: Map<string, { raw: string; hex: string | null }>,
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const [prop, raw] of Object.entries(computedStyle)) {
    if (raw == null || raw === "") continue;
    const value = String(raw).trim();
    if (!value) continue;
    // Exact match.
    for (const [dtcg, entry] of tokenIndex) {
      if (entry.raw === value) {
        if (!seen.has(dtcg)) { refs.push(dtcg); seen.add(dtcg); }
        continue;
      }
      // Try rgb-to-hex for color-ish values.
      if (entry.hex) {
        const asHex = rgbToHex(value);
        if (asHex && asHex === entry.hex) {
          if (!seen.has(dtcg)) { refs.push(dtcg); seen.add(dtcg); }
        }
      }
    }
  }
  return refs;
}

// ============================================================================
// Extractor
// ============================================================================

/** Tokens the extractor picks up from the page-side walker. */
interface ExtractedToken {
  name: string;     // e.g. "--color-accent"
  value: string;    // computed value at :root
}

export const visualExtractor: Extractor = {
  name: "visual",

  async run({ graph, page, pageNode, log, viewports }) {
    const t0 = Date.now();
    const pageId = pageNode.id;

    // Determine viewport profiles to extract (VI-01)
    const baseVp: ViewportProfile = {
      name: "desktop",
      w: pageNode.viewport.w || 1440,
      h: pageNode.viewport.h || 900,
      dpr: pageNode.viewport.dpr || 1,
    };
    const profilesToRun = (viewports && viewports.length > 0) ? viewports : [baseVp];

    // 1. Walk CSS custom properties once
    const rawTokens = await page.script.callFunction<ExtractedToken[]>(
      page.target, TOKEN_WALKER_FN, [],
    );
    const tokens = Array.isArray(rawTokens) ? rawTokens : [];
    for (const t of tokens) {
      const dtcgPath = kebabToDtcg(t.name);
      const type = guessDtcgType(t.value);
      const token: DtcgToken = {
        $value: t.value,
        $type: type,
        $description: dtcgPath,
      };
      graph.upsertToken(dtcgPath, token);
    }
    const tokenIndex = new Map<string, { raw: string; hex: string | null }>();
    for (const t of tokens) {
      const dtcgPath = kebabToDtcg(t.name);
      tokenIndex.set(dtcgPath, { raw: t.value, hex: rgbToHex(t.value) });
    }

    let primaryWalkElements: VisualElementRaw[] = [];

    // 2. Iterate through configured viewport profiles (VI-01 multi-viewport snapshots)
    for (let idx = 0; idx < profilesToRun.length; idx++) {
      const vp = profilesToRun[idx]!;
      if (typeof (page as any).setViewport === "function") {
        await (page as any).setViewport(vp).catch(() => {});
      }

      const walk = await page.script.callFunction<VisualWalkResult>(
        page.target, VISUAL_WALKER_FN, [pageId],
      );

      if (idx === 0) {
        primaryWalkElements = walk.elements;
      }

      const tethersByAxId = computeTethers(walk.elements);

      for (const el of walk.elements) {
        const tethers = tethersByAxId.get(el.axId) ?? {
          parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [],
        };
        const designTokenRefs = matchTokenRefs(el.computedStyle, tokenIndex);
        const visibility = el.computedStyle?.display === "none" || el.computedStyle?.visibility === "hidden" ? "hidden" : "visible";

        const boxModel = el.boxModel ?? computeBoxModel(el.rect, el.computedStyle);
        const scrollClippingContext = el.scrollClippingContext ?? computeScrollClippingContext(
          {
            scrollWidth: el.rect.w,
            scrollHeight: el.rect.h,
            scrollLeft: 0,
            scrollTop: 0,
            clientWidth: el.rect.w,
            clientHeight: el.rect.h,
          },
          el.computedStyle,
        );
        const stackingContext = el.stackingContext ?? computeStackingContext(el.computedStyle, false);
        const renderBounds = el.renderBounds ?? computeRenderBounds(el.rect, el.rect, el.computedStyle);
        const containerInfo = (el.isVisualContainer !== undefined && el.containerType !== undefined)
          ? { isVisualContainer: el.isVisualContainer, containerType: el.containerType }
          : classifyVisualContainer(
              { tag: el.tag ?? "div", elementId: el.elementId ?? null, rect: el.rect },
              el.computedStyle,
              boxModel,
              scrollClippingContext,
            );

        const observation: ViewportObservation = {
          viewport: vp,
          rect: el.rect,
          computedStyle: el.computedStyle,
          visibility,
          tethers,
          crawledAt: new Date().toISOString(),
          isVisualContainer: containerInfo.isVisualContainer,
          containerType: containerInfo.containerType,
          boxModel,
          scrollClippingContext,
          stackingContext,
          renderBounds,
        };

        if (idx === 0) {
          // If AxNode doesn't exist for this visual element (e.g. non-semantic container), upsert a synthetic AxNode
          if (!graph.getAx(el.axId)) {
            const tag = (el.tag ?? "div").toLowerCase();
            const isLandmark = ["section", "article", "main", "aside", "nav", "header", "footer", "dialog", "form"].includes(tag);
            graph.upsertAx({
              id: el.axId,
              type: "ax-node",
              pageId,
              role: isLandmark ? (tag as any) : "generic",
              name: el.elementId ?? (containerInfo.isVisualContainer ? `${containerInfo.containerType}-${tag}` : ""),
              nameSource: "attribute",
              states: {
                busy: false,
                disabled: false,
                expanded: null,
                pressed: null,
                selected: null,
                checked: null,
                open: null,
                current: null,
              },
              properties: {
                controls: [],
                describedBy: [],
                labelledBy: [],
                level: null,
                live: null,
                orientation: null,
                posInSet: null,
                setSize: null,
                valueNow: null,
                valueMin: null,
                valueMax: null,
                valueText: null,
              },
              apgPattern: null,
              focusable: false,
              visibility,
              inPageDomOrder: el.domOrder ?? 0,
              parentAxId: el.parentAxId ?? null,
              provenance: VISUAL_PROVENANCE,
            });
          }

          // Primary baseline node
          const tokenMap = graph.getTokens();
          const designTokenBindings = tokenMap.size > 0 ? bindTokensToNode(el.computedStyle, tokenMap) : [];
          const tokenDrifts = tokenMap.size > 0 ? detectTokenDrifts(el.axId, pageId, el.computedStyle, tokenMap) : [];

          const vis: VisualNode = {
            id: `vis:${pageId}:${el.axId}`,
            type: "visual-node",
            axId: el.axId,
            pageId,
            rect: el.rect,
            computedStyle: el.computedStyle,
            designTokenRefs,
            designTokenBindings: designTokenBindings.length > 0 ? designTokenBindings : undefined,
            tokenDrifts: tokenDrifts.length > 0 ? tokenDrifts : undefined,
            tethers,
            provenance: VISUAL_PROVENANCE,
            viewport: vp,
            isVisualContainer: containerInfo.isVisualContainer,
            containerType: containerInfo.containerType,
            boxModel,
            scrollClippingContext,
            stackingContext,
            renderBounds,
            viewportObservations: {
              [vp.name.toLowerCase()]: observation,
            },
          };
          graph.upsertVisual(vis);
        } else {
          // Additional multi-viewport observation
          graph.addViewportObservation(el.axId, observation);
          // Also register discrete observation node preserving element identity
          const tokenMap = graph.getTokens();
          const designTokenBindings = tokenMap.size > 0 ? bindTokensToNode(el.computedStyle, tokenMap) : [];
          const tokenDrifts = tokenMap.size > 0 ? detectTokenDrifts(el.axId, pageId, el.computedStyle, tokenMap) : [];

          const discreteVis: VisualNode = {
            id: `vis:${pageId}:${el.axId}:${vp.name.toLowerCase()}`,
            type: "visual-node",
            axId: el.axId,
            pageId,
            rect: el.rect,
            computedStyle: el.computedStyle,
            designTokenRefs,
            designTokenBindings: designTokenBindings.length > 0 ? designTokenBindings : undefined,
            tokenDrifts: tokenDrifts.length > 0 ? tokenDrifts : undefined,
            tethers,
            provenance: VISUAL_PROVENANCE,
            viewport: vp,
            isVisualContainer: containerInfo.isVisualContainer,
            containerType: containerInfo.containerType,
            boxModel,
            scrollClippingContext,
            stackingContext,
            renderBounds,
          };
          graph.upsertVisual(discreteVis);
        }
      }
    }

    // 3. ED-06 interpretive layer: grid/flex structure + alignment relations on primary view.
    const allVis = primaryWalkElements.map((el) => graph.getVisual(`vis:${pageId}:${el.axId}`)!).filter(Boolean);

    // VI-03: Occlusion computation under viewport and ancestor clipping boundaries
    const primaryVp = profilesToRun[0] ?? { name: "desktop", w: 1440, h: 900 };
    const occlusionMap = computePageOcclusion(allVis, { w: primaryVp.w, h: primaryVp.h });
    for (const node of allVis) {
      const occ = occlusionMap.get(node.id);
      if (occ) {
        node.occlusion = occ;
        if (node.viewportObservations && node.viewportObservations[primaryVp.name.toLowerCase()]) {
          node.viewportObservations[primaryVp.name.toLowerCase()]!.occlusion = occ;
        }
      }
    }

    const { layoutEdges } = interpretPage(allVis, pageId, VISUAL_PROVENANCE);
    for (const edge of layoutEdges) {
      graph.upsertEdge(edge as Parameters<typeof graph.upsertEdge>[0]);
    }

    // VI-03: Spatial layout proximity relations (visual:above, visual:below, visual:left-of, visual:right-of, visual:nested-in)
    const spatialEdges = extractSpatialEdges(allVis, VISUAL_PROVENANCE);
    for (const edge of spatialEdges) {
      graph.upsertEdge(edge);
    }

    // VI-04: Semantic visual pattern classification (fab, modal-backdrop, sticky-header, etc.)
    const patternMap = classifyPageVisualPatterns(
      allVis,
      (axId) => graph.getAx(axId),
      { w: primaryVp.w, h: primaryVp.h },
    );
    for (const node of allVis) {
      const pats = patternMap.get(node.id);
      if (pats && pats.length > 0) {
        node.patterns = pats;
        node.primaryPattern = pats[0]!.pattern;
        if (node.viewportObservations && node.viewportObservations[primaryVp.name.toLowerCase()]) {
          node.viewportObservations[primaryVp.name.toLowerCase()]!.patterns = pats;
          node.viewportObservations[primaryVp.name.toLowerCase()]!.primaryPattern = pats[0]!.pattern;
        }
      }
    }
    log(`  [interpret] grid/flex nodes=${allVis.filter((n) => n.interpretation?.grid ?? n.interpretation?.flex).length} layout-edges=${layoutEdges.length} spatial-edges=${spatialEdges.length} patterns=${patternMap.size}`);

    const t = Date.now() - t0;
    const vpSuffix = profilesToRun.length > 1 ? ` viewports=${profilesToRun.length}` : "";
    log(`  [visual] nodes=${primaryWalkElements.length} tokens=${tokens.length}${vpSuffix} (${t}ms)`);
    return { produced: primaryWalkElements.length > 0, durationMs: t };
  },
};
