/**
 * VI-03: Occlusion Detection and Visual Clipping Trees.
 *
 * Computes exact visible area ratios, ancestor and viewport clipping boundaries,
 * and identifies occluding overlapping elements using 2D boolean rect subtraction.
 */
import type {
  OcclusionInfo,
  Rect,
  VisualNode,
} from "../graph/types.js";

/**
 * Compute the intersection of two rectangles.
 * Returns null if they do not overlap.
 */
export function computeRectIntersection(r1: Rect, r2: Rect): Rect | null {
  const x = Math.max(r1.x, r2.x);
  const y = Math.max(r1.y, r2.y);
  const right = Math.min(r1.x + r1.w, r2.x + r2.w);
  const bottom = Math.min(r1.y + r1.h, r2.y + r2.h);
  const w = right - x;
  const h = bottom - y;

  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * Compute the area of a rectangle.
 */
export function computeRectArea(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/**
 * Subtract occluding rectangle `O` from base rectangle `R`.
 * Returns 0 to 4 non-overlapping sub-rectangles representing the unoccluded portions of `R`.
 */
export function subtractRect(R: Rect, O: Rect): Rect[] {
  const I = computeRectIntersection(R, O);
  if (!I) return [R]; // No overlap, R remains entirely unoccluded.

  const result: Rect[] = [];

  // 1. Top slice (above intersection)
  if (I.y > R.y) {
    result.push({
      x: R.x,
      y: R.y,
      w: R.w,
      h: I.y - R.y,
    });
  }

  // 2. Bottom slice (below intersection)
  const bottomR = R.y + R.h;
  const bottomI = I.y + I.h;
  if (bottomR > bottomI) {
    result.push({
      x: R.x,
      y: bottomI,
      w: R.w,
      h: bottomR - bottomI,
    });
  }

  // 3. Left slice (to the left of intersection, constrained vertically to I's y range)
  if (I.x > R.x) {
    result.push({
      x: R.x,
      y: I.y,
      w: I.x - R.x,
      h: I.h,
    });
  }

  // 4. Right slice (to the right of intersection, constrained vertically to I's y range)
  const rightR = R.x + R.w;
  const rightI = I.x + I.w;
  if (rightR > rightI) {
    result.push({
      x: rightI,
      y: I.y,
      w: rightR - rightI,
      h: I.h,
    });
  }

  return result.filter((r) => r.w > 0 && r.h > 0);
}

/**
 * Compute the unoccluded area of a base rectangle after subtracting a set of occluding rectangles.
 */
export function computeUnoccludedArea(base: Rect, occluders: Rect[]): number {
  let fragments: Rect[] = [base];

  for (const occluder of occluders) {
    const nextFragments: Rect[] = [];
    for (const fragment of fragments) {
      const remaining = subtractRect(fragment, occluder);
      nextFragments.push(...remaining);
    }
    fragments = nextFragments;
    if (fragments.length === 0) break;
  }

  return fragments.reduce((sum, f) => sum + computeRectArea(f), 0);
}

/**
 * Determine if `candidate` renders on top of `target` in paint order.
 */
export function isCandidateAbove(candidate: VisualNode, target: VisualNode): boolean {
  // Stacking context z-index comparison
  const zCandVal = candidate.stackingContext?.zIndex;
  const zCand = typeof zCandVal === "number" ? zCandVal : parseFloat(candidate.computedStyle?.zIndex ?? "0");

  const zTargetVal = target.stackingContext?.zIndex;
  const zTarget = typeof zTargetVal === "number" ? zTargetVal : parseFloat(target.computedStyle?.zIndex ?? "0");

  const numCandZ = isNaN(zCand) ? 0 : zCand;
  const numTargetZ = isNaN(zTarget) ? 0 : zTarget;

  if (numCandZ > numTargetZ) return true;
  if (numCandZ < numTargetZ) return false;

  // Stacking context vs non-stacking context
  if (candidate.stackingContext?.isStackingContext && !target.stackingContext?.isStackingContext) {
    return true;
  }
  if (!candidate.stackingContext?.isStackingContext && target.stackingContext?.isStackingContext) {
    return false;
  }

  // Fixed/sticky overlays generally paint above static content
  const posCand = candidate.computedStyle?.position;
  const posTarget = target.computedStyle?.position;
  if ((posCand === "fixed" || posCand === "sticky") && (posTarget !== "fixed" && posTarget !== "sticky")) {
    return true;
  }

  return false;
}

/**
 * True if node is visible and capable of occluding content below it.
 */
export function canOcclude(node: VisualNode): boolean {
  const cs = node.computedStyle;
  if (!cs) return true;

  if (cs.display === "none" || cs.visibility === "hidden") return false;
  const opacity = parseFloat(cs.opacity ?? "1");
  if (!isNaN(opacity) && opacity < 0.1) return false;

  const bg = cs.backgroundColor ?? "";
  if (bg === "transparent" || bg === "rgba(0, 0, 0, 0)") {
    const hasBorder = cs.border && cs.border !== "none" && !cs.border.startsWith("0px");
    const hasBoxShadow = cs.boxShadow && cs.boxShadow !== "none";
    if (!hasBorder && !hasBoxShadow && node.tethers.children.length === 0) {
      return false;
    }
  }

  return true;
}

/**
 * Compute ancestor clipping boundaries for a node.
 */
export function computeAncestorClipping(
  node: VisualNode,
  byVisId: Map<string, VisualNode>,
  viewportRect: Rect,
): { clippedRect: Rect | null; isOffscreen: boolean } {
  const baseRect = node.renderBounds?.transformed ?? node.rect;
  if (!baseRect || baseRect.w <= 0 || baseRect.h <= 0) {
    return { clippedRect: null, isOffscreen: true };
  }

  // 1. Clip against viewport
  let currentClip: Rect | null = computeRectIntersection(baseRect, viewportRect);
  if (!currentClip) {
    return { clippedRect: null, isOffscreen: true };
  }

  // 2. Walk up parent tethers to clip against any overflow container ancestors
  let parentId = node.tethers.parent;
  while (parentId) {
    const parent = byVisId.get(parentId);
    if (!parent) break;

    const isScroll = parent.scrollClippingContext?.isScrollContainer;
    const overflow = parent.computedStyle?.overflow ?? "";
    const isOverflowClipped = isScroll || overflow === "hidden" || overflow === "scroll" || overflow === "auto";

    if (isOverflowClipped) {
      const parentRect = parent.boxModel?.paddingBox ?? parent.rect;
      currentClip = computeRectIntersection(currentClip, parentRect);
      if (!currentClip) {
        return { clippedRect: null, isOffscreen: true };
      }
    }

    parentId = parent.tethers.parent;
  }

  return { clippedRect: currentClip, isOffscreen: false };
}

/**
 * Compute occlusion information for a single node.
 */
export function computeNodeOcclusion(
  node: VisualNode,
  allNodes: VisualNode[],
  byVisId: Map<string, VisualNode>,
  viewport: { w: number; h: number },
): OcclusionInfo {
  const baseRect = node.renderBounds?.transformed ?? node.rect;
  const totalArea = computeRectArea(baseRect);

  if (totalArea <= 0) {
    return {
      visibleRatio: 0,
      isOccluded: true,
      occludedBy: [],
      clippedRect: null,
      isOffscreen: true,
      occludedArea: 0,
      visibleArea: 0,
    };
  }

  const viewportRect: Rect = { x: 0, y: 0, w: viewport.w, h: viewport.h };
  const { clippedRect, isOffscreen } = computeAncestorClipping(node, byVisId, viewportRect);

  if (isOffscreen || !clippedRect) {
    return {
      visibleRatio: 0,
      isOccluded: true,
      occludedBy: [],
      clippedRect: null,
      isOffscreen: true,
      occludedArea: totalArea,
      visibleArea: 0,
    };
  }

  // Find all higher paint-order nodes that intersect clippedRect
  const occluders: Rect[] = [];
  const occludedBy: string[] = [];

  // Set of descendants of node (an element is not occluded by its own children)
  const descendants = new Set<string>();
  const collectDescendants = (id: string) => {
    const n = byVisId.get(id);
    if (!n) return;
    for (const ch of n.tethers.children) {
      if (!descendants.has(ch)) {
        descendants.add(ch);
        collectDescendants(ch);
      }
    }
  };
  collectDescendants(node.id);

  for (const other of allNodes) {
    if (other.id === node.id) continue;
    if (descendants.has(other.id)) continue;
    if (!canOcclude(other)) continue;

    if (isCandidateAbove(other, node)) {
      const otherRect = other.renderBounds?.transformed ?? other.rect;
      const intersection = computeRectIntersection(clippedRect, otherRect);
      if (intersection && computeRectArea(intersection) > 0) {
        occluders.push(intersection);
        occludedBy.push(other.id);
      }
    }
  }

  const unoccludedArea = computeUnoccludedArea(clippedRect, occluders);
  const visibleArea = Math.round(unoccludedArea);
  const visibleRatio = totalArea > 0 ? Number(Math.max(0, Math.min(1, unoccludedArea / totalArea)).toFixed(4)) : 0;
  const occludedArea = Math.round(Math.max(0, totalArea - visibleArea));
  const isOccluded = visibleRatio < 0.5;

  return {
    visibleRatio,
    isOccluded,
    occludedBy,
    clippedRect,
    isOffscreen,
    occludedArea,
    visibleArea,
  };
}

/**
 * Compute occlusion across all VisualNodes on a page.
 */
export function computePageOcclusion(
  nodes: VisualNode[],
  viewport: { w: number; h: number } = { w: 1440, h: 900 },
): Map<string, OcclusionInfo> {
  const byVisId = new Map<string, VisualNode>();
  for (const n of nodes) byVisId.set(n.id, n);

  const results = new Map<string, OcclusionInfo>();
  for (const node of nodes) {
    const occ = computeNodeOcclusion(node, nodes, byVisId, viewport);
    results.set(node.id, occ);
  }

  return results;
}
