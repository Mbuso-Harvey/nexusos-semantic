/**
 * Visual Regression Diffing Engine — NexusOS / VI-05.
 *
 * Provides cross-graph and temporal visual regression diffing between baseline
 * and candidate UI states:
 * 1. Geometric layout shifts (translation dx/dy, element layout-shift scoring).
 * 2. Dimension changes (dw/dh delta calculation and aspect ratio variance).
 * 3. Style drifts (color, typography, opacity, zIndex deviations).
 * 4. Design token detachment (reversion from token-bound to hardcoded styles).
 * 5. Visibility and occlusion regressions (clipping, offscreen drift, occlusion).
 * 6. Semantic pattern degradation (degradation of FAB, Sticky Header, Modals).
 */
import type {
  VisualNode,
  VisualNodeDiff,
  VisualRegressionDefect,
  VisualRegressionReport,
  VisualRegressionSeverity,
} from "../graph/types.js";

export interface VisualRegressionOptions {
  /** Minimum pixel shift threshold to register as a layout shift (default 1.0) */
  minShiftThresholdPx?: number;
  /** Minimum dimension delta to register as a dimension change (default 1.0) */
  minDimensionThresholdPx?: number;
  /** Page viewport bounds used for CLS normalization (default { w: 1920, h: 1080 }) */
  viewportBounds?: { w: number; h: number };
}

const SEVERITY_WEIGHT: Record<VisualRegressionSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

export function maxSeverity(
  s1: VisualRegressionSeverity,
  s2: VisualRegressionSeverity,
): VisualRegressionSeverity {
  return SEVERITY_WEIGHT[s1] >= SEVERITY_WEIGHT[s2] ? s1 : s2;
}

// Properties to inspect for style drift
const REGRESSION_STYLE_PROPS = [
  "color",
  "background-color",
  "backgroundColor",
  "font-size",
  "fontSize",
  "font-weight",
  "fontWeight",
  "opacity",
  "display",
  "visibility",
  "z-index",
  "zIndex",
] as const;


/**
 * Compare two visual observations of the same node (baseline vs candidate) and compute defects.
 */
export function diffVisualNodes(
  baseline: VisualNode,
  candidate: VisualNode,
  options: VisualRegressionOptions = {},
): VisualNodeDiff {
  const minShift = options.minShiftThresholdPx ?? 1.0;
  const minDim = options.minDimensionThresholdPx ?? 1.0;
  const vp = options.viewportBounds ?? { w: 1920, h: 1080 };
  const vpArea = Math.max(1, vp.w * vp.h);

  const defects: VisualRegressionDefect[] = [];
  let currentMaxSeverity: VisualRegressionSeverity = "none";
  let layoutShiftScore = 0;

  // 1. Layout Shift (dx, dy)
  const dx = candidate.rect.x - baseline.rect.x;
  const dy = candidate.rect.y - baseline.rect.y;
  const shiftDist = Math.sqrt(dx * dx + dy * dy);

  if (shiftDist >= minShift) {
    const nodeArea = baseline.rect.w * baseline.rect.h;
    // Normalized layout shift score: (impact fraction) * (distance fraction)
    const impactFraction = Math.min(1.0, nodeArea / vpArea);
    const distanceFraction = Math.min(1.0, shiftDist / Math.max(vp.w, vp.h));
    layoutShiftScore = Math.round(impactFraction * distanceFraction * 10000) / 10000;

    let sev: VisualRegressionSeverity = "low";
    if (shiftDist >= 50) sev = "critical";
    else if (shiftDist >= 15) sev = "high";
    else if (shiftDist >= 5) sev = "medium";

    defects.push({
      kind: "layout-shift",
      severity: sev,
      delta: Math.round(shiftDist * 10) / 10,
      description: `Layout shifted by (${Math.round(dx)}px, ${Math.round(dy)}px), total translation ${Math.round(shiftDist * 10) / 10}px`,
      baselineValue: { x: baseline.rect.x, y: baseline.rect.y },
      candidateValue: { x: candidate.rect.x, y: candidate.rect.y },
    });
    currentMaxSeverity = maxSeverity(currentMaxSeverity, sev);
  }

  // 2. Dimension Change (dw, dh)
  const dw = candidate.rect.w - baseline.rect.w;
  const dh = candidate.rect.h - baseline.rect.h;
  const absDw = Math.abs(dw);
  const absDh = Math.abs(dh);

  if (absDw >= minDim || absDh >= minDim) {
    let sev: VisualRegressionSeverity = "low";
    if (absDw >= 50 || absDh >= 50) sev = "high";
    else if (absDw >= 10 || absDh >= 10) sev = "medium";

    defects.push({
      kind: "dimension-change",
      severity: sev,
      delta: Math.round(Math.max(absDw, absDh) * 10) / 10,
      description: `Dimensions changed from ${baseline.rect.w}x${baseline.rect.h} to ${candidate.rect.w}x${candidate.rect.h} (Δw: ${Math.round(dw)}px, Δh: ${Math.round(dh)}px)`,
      baselineValue: { w: baseline.rect.w, h: baseline.rect.h },
      candidateValue: { w: candidate.rect.w, h: candidate.rect.h },
    });
    currentMaxSeverity = maxSeverity(currentMaxSeverity, sev);
  }

  // 3. Style Drift
  const inspectedProps = new Set<string>();
  for (const prop of REGRESSION_STYLE_PROPS) {
    if (inspectedProps.has(prop)) continue;
    inspectedProps.add(prop);
    const baseVal = (baseline.computedStyle as Record<string, any>)[prop];
    const candVal = (candidate.computedStyle as Record<string, any>)[prop];

    if (baseVal && candVal && String(baseVal).trim() !== String(candVal).trim()) {
      let sev: VisualRegressionSeverity = "low";
      if (prop === "display" || prop === "visibility") {
        sev = "critical";
      } else if (prop.includes("color") || prop.includes("background") || prop.includes("font")) {
        sev = "medium";
      }

      defects.push({
        kind: "style-drift",
        severity: sev,
        property: prop,
        baselineValue: baseVal,
        candidateValue: candVal,
        description: `Style '${prop}' changed from '${baseVal}' to '${candVal}'`,
      });
      currentMaxSeverity = maxSeverity(currentMaxSeverity, sev);
    }
  }

  // 4. Token Detachment
  const baseTokens = new Set([
    ...(baseline.designTokenRefs || []),
    ...(baseline.designTokenBindings?.map((b) => b.tokenPath) || []),
  ]);
  const candTokens = new Set([
    ...(candidate.designTokenRefs || []),
    ...(candidate.designTokenBindings?.map((b) => b.tokenPath) || []),
  ]);
  for (const token of baseTokens) {
    if (!candTokens.has(token)) {
      defects.push({
        kind: "token-detachment",
        severity: "medium",
        property: "designTokenBindings",
        baselineValue: token,
        candidateValue: null,
        description: `Design token '${token}' was detached in candidate build`,
      });
      currentMaxSeverity = maxSeverity(currentMaxSeverity, "medium");
    }
  }

  // 5. Visibility / Occlusion Regression
  const baseRatio = baseline.occlusion?.visibleRatio ?? (baseline.computedStyle?.visibility !== "hidden" && baseline.computedStyle?.display !== "none" ? 1.0 : 0);
  const candRatio = candidate.occlusion?.visibleRatio ?? (candidate.computedStyle?.visibility !== "hidden" && candidate.computedStyle?.display !== "none" ? 1.0 : 0);
  const baseOccluded = baseline.occlusion?.isOccluded ?? false;
  const candOccluded = candidate.occlusion?.isOccluded ?? false;
  if ((!baseOccluded && candOccluded) || (baseRatio - candRatio >= 0.5)) {
    const sev: VisualRegressionSeverity = (candRatio <= 0.2) ? "critical" : "high";
    defects.push({
      kind: "visibility-regression",
      severity: sev,
      description: `Element became occluded or visibility dropped from ratio ${Math.round(baseRatio * 100)}% to ${Math.round(candRatio * 100)}%`,
      baselineValue: { isOccluded: baseOccluded, visibleRatio: baseRatio },
      candidateValue: { isOccluded: candOccluded, visibleRatio: candRatio },
    });
    currentMaxSeverity = maxSeverity(currentMaxSeverity, sev);
  }

  // 6. Semantic Pattern Degradation
  if (baseline.primaryPattern && baseline.primaryPattern !== candidate.primaryPattern) {
    defects.push({
      kind: "pattern-degradation",
      severity: "high",
      description: `Semantic visual pattern changed from '${baseline.primaryPattern}' to '${candidate.primaryPattern || "none"}'`,
      baselineValue: baseline.primaryPattern,
      candidateValue: candidate.primaryPattern ?? null,
    });
    currentMaxSeverity = maxSeverity(currentMaxSeverity, "high");
  }

  return {
    axId: candidate.axId || baseline.axId,
    baselineVisId: baseline.id,
    candidateVisId: candidate.id,
    hasRegression: defects.length > 0,
    maxSeverity: currentMaxSeverity,
    defects,
    layoutShiftScore,
  };
}

/**
 * Perform a full page-level visual regression analysis comparing baseline and candidate VisualNodes.
 */
export function diffPageVisualRegression(
  baselineNodes: VisualNode[],
  candidateNodes: VisualNode[],
  pageId: string,
  options: VisualRegressionOptions = {},
): VisualRegressionReport {
  const baselineByAx = new Map<string, VisualNode>();
  for (const n of baselineNodes) {
    if (n.axId) baselineByAx.set(n.axId, n);
  }

  const candidateByAx = new Map<string, VisualNode>();
  for (const n of candidateNodes) {
    if (n.axId) candidateByAx.set(n.axId, n);
  }

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const nodeDiffs: VisualNodeDiff[] = [];

  let clsSum = 0;
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
  };
  let pageMaxSeverity: VisualRegressionSeverity = "none";

  // Check candidate nodes against baseline
  for (const [axId, candNode] of candidateByAx.entries()) {
    const baseNode = baselineByAx.get(axId);
    if (!baseNode) {
      addedNodes.push(axId);
      continue;
    }

    const diff = diffVisualNodes(baseNode, candNode, options);
    if (diff.hasRegression) {
      counts[diff.maxSeverity]++;
      pageMaxSeverity = maxSeverity(pageMaxSeverity, diff.maxSeverity);
    } else {
      counts.none++;
    }
    clsSum += diff.layoutShiftScore;
    nodeDiffs.push(diff);
  }

  // Check removed nodes
  for (const [axId, baseNode] of baselineByAx.entries()) {
    if (!candidateByAx.has(axId)) {
      removedNodes.push(axId);
      const isImportant = baseNode.primaryPattern || baseNode.designTokenRefs.length > 0;
      const sev: VisualRegressionSeverity = isImportant ? "high" : "medium";
      counts[sev]++;
      pageMaxSeverity = maxSeverity(pageMaxSeverity, sev);
      nodeDiffs.push({
        axId,
        baselineVisId: baseNode.id,
        candidateVisId: undefined,
        hasRegression: true,
        maxSeverity: sev,
        defects: [
          {
            kind: "visibility-regression",
            severity: sev,
            description: `Element present in baseline was removed or not rendered in candidate`,
            baselineValue: { id: baseNode.id, rect: baseNode.rect },
            candidateValue: null,
          },
        ],
        layoutShiftScore: 0,
      });
    }
  }

  const regressedNodesCount = nodeDiffs.filter((d) => d.hasRegression).length;

  return {
    pageId,
    totalNodesCompared: baselineByAx.size,
    regressedNodesCount,
    maxSeverity: pageMaxSeverity,
    counts,
    cumulativeLayoutShift: Math.round(clsSum * 10000) / 10000,
    nodeDiffs,
    addedNodes,
    removedNodes,
    timestamp: new Date().toISOString(),
  };
}


