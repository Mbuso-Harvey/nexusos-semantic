/**
 * VI-03: Spatial Proximity Relationships.
 *
 * Computes spatial layout relationships between elements:
 *   - visual:above
 *   - visual:below
 *   - visual:left-of
 *   - visual:right-of
 *   - visual:nested-in
 */
import type { Edge, EdgeKind, VisualNode } from "../graph/types.js";

export const MAX_SPATIAL_DISTANCE_PX = 64;
export const MIN_OVERLAP_PX = 4;
export const CONTAINMENT_TOLERANCE_PX = 2;

export interface DetectedSpatialRelation {
  kind: "visual:above" | "visual:below" | "visual:left-of" | "visual:right-of" | "visual:nested-in";
  distance: number;
  overlap: number;
}

/**
 * 1D projection overlap between two segments [aStart, aStart + aSize] and [bStart, bStart + bSize].
 */
export function computeSegmentOverlap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  const overlap = Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart);
  return Math.max(0, overlap);
}

/**
 * Detect spatial layout relations from element `a` to element `b`.
 */
export function detectSpatialRelations(a: VisualNode, b: VisualNode): DetectedSpatialRelation[] {
  if (a.id === b.id) return [];

  const ar = a.renderBounds?.transformed ?? a.rect;
  const br = b.renderBounds?.transformed ?? b.rect;

  if (!ar || !br || ar.w <= 0 || ar.h <= 0 || br.w <= 0 || br.h <= 0) return [];

  const relations: DetectedSpatialRelation[] = [];

  // 1. Nested-in: a is geometrically contained inside b
  const isContained =
    ar.x >= br.x - CONTAINMENT_TOLERANCE_PX &&
    ar.y >= br.y - CONTAINMENT_TOLERANCE_PX &&
    ar.x + ar.w <= br.x + br.w + CONTAINMENT_TOLERANCE_PX &&
    ar.y + ar.h <= br.y + br.h + CONTAINMENT_TOLERANCE_PX &&
    ar.w * ar.h < br.w * br.h;

  if (isContained) {
    relations.push({
      kind: "visual:nested-in",
      distance: 0,
      overlap: Math.round(ar.w * ar.h),
    });
    // If nested-in, we do not need directional above/below/left/right between child and parent container
    return relations;
  }

  const overlapX = computeSegmentOverlap(ar.x, ar.w, br.x, br.w);
  const overlapY = computeSegmentOverlap(ar.y, ar.h, br.y, br.h);

  // 2. Above: a is directly above b
  if (overlapX >= MIN_OVERLAP_PX) {
    const gapDown = br.y - (ar.y + ar.h);
    if (gapDown >= -CONTAINMENT_TOLERANCE_PX && gapDown <= MAX_SPATIAL_DISTANCE_PX) {
      relations.push({
        kind: "visual:above",
        distance: Math.max(0, Math.round(gapDown)),
        overlap: Math.round(overlapX),
      });
    }

    const gapUp = ar.y - (br.y + br.h);
    if (gapUp >= -CONTAINMENT_TOLERANCE_PX && gapUp <= MAX_SPATIAL_DISTANCE_PX) {
      relations.push({
        kind: "visual:below",
        distance: Math.max(0, Math.round(gapUp)),
        overlap: Math.round(overlapX),
      });
    }
  }

  // 3. Left-of / Right-of
  if (overlapY >= MIN_OVERLAP_PX) {
    const gapRight = br.x - (ar.x + ar.w);
    if (gapRight >= -CONTAINMENT_TOLERANCE_PX && gapRight <= MAX_SPATIAL_DISTANCE_PX) {
      relations.push({
        kind: "visual:left-of",
        distance: Math.max(0, Math.round(gapRight)),
        overlap: Math.round(overlapY),
      });
    }

    const gapLeft = ar.x - (br.x + br.w);
    if (gapLeft >= -CONTAINMENT_TOLERANCE_PX && gapLeft <= MAX_SPATIAL_DISTANCE_PX) {
      relations.push({
        kind: "visual:right-of",
        distance: Math.max(0, Math.round(gapLeft)),
        overlap: Math.round(overlapY),
      });
    }
  }

  return relations;
}

/**
 * Extract spatial proximity edges across VisualNodes on a page.
 */
export function extractSpatialEdges(
  nodes: VisualNode[],
  provenance: string,
): Edge[] {
  const edges: Edge[] = [];
  const seenEdgeIds = new Set<string>();

  // Spatial binning for O(N log N) candidate pair detection
  const GRID_SIZE = 128;
  const grid = new Map<string, VisualNode[]>();

  for (const node of nodes) {
    const r = node.renderBounds?.transformed ?? node.rect;
    if (!r || r.w <= 0 || r.h <= 0) continue;

    const startX = Math.floor(r.x / GRID_SIZE);
    const endX = Math.floor((r.x + r.w + MAX_SPATIAL_DISTANCE_PX) / GRID_SIZE);
    const startY = Math.floor(r.y / GRID_SIZE);
    const endY = Math.floor((r.y + r.h + MAX_SPATIAL_DISTANCE_PX) / GRID_SIZE);

    for (let gx = startX; gx <= endX; gx++) {
      for (let gy = startY; gy <= endY; gy++) {
        const key = `${gx}:${gy}`;
        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push(node);
      }
    }
  }

  const checkedPairs = new Set<string>();

  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        // Check relations A -> B
        const relsAtoB = detectSpatialRelations(a, b);
        for (const rel of relsAtoB) {
          const edgeId = `edge:${a.id}->${b.id}:${rel.kind}`;
          if (!seenEdgeIds.has(edgeId)) {
            seenEdgeIds.add(edgeId);
            edges.push({
              id: edgeId,
              type: "edge",
              from: a.id,
              to: b.id,
              kind: rel.kind as EdgeKind,
              provenance: provenance as any,
              spatial: {
                distance: rel.distance,
                overlap: rel.overlap,
              },
            });
          }
        }

        // Check relations B -> A
        const relsBtoA = detectSpatialRelations(b, a);
        for (const rel of relsBtoA) {
          const edgeId = `edge:${b.id}->${a.id}:${rel.kind}`;
          if (!seenEdgeIds.has(edgeId)) {
            seenEdgeIds.add(edgeId);
            edges.push({
              id: edgeId,
              type: "edge",
              from: b.id,
              to: a.id,
              kind: rel.kind as EdgeKind,
              provenance: provenance as any,
              spatial: {
                distance: rel.distance,
                overlap: rel.overlap,
              },
            });
          }
        }
      }
    }
  }

  return edges;
}
