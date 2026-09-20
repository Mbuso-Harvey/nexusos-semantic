/**
 * extract-visual: VI-04 High-Level Semantic Visual Patterns & Layout Mutation Classifier
 *
 * Implements:
 * 1. Semantic visual pattern detection:
 *    - Floating Action Buttons (fab)
 *    - Modal backdrops & dialog overlays (modal-backdrop, dialog-overlay)
 *    - Sticky headers & footers (sticky-header, sticky-footer)
 *    - Dismiss / close buttons (dismiss-button)
 *    - Form groupings (form-group)
 *    - Toast notifications & snackbars (toast-notification)
 *
 * 2. Cross-view responsive layout mutation classification:
 *    - reflow: dimension or structural layout reflow
 *    - hide: element becomes hidden or zero-dimensioned
 *    - show: element emerges or becomes visible
 *    - reorder: visual ordering inversion across viewports
 *    - reposition: coordinate translation without dimension reflow
 *    - unchanged: preserved geometry and visibility
 */

import type {
  AxNode,
  LayoutMutation,
  LayoutMutationType,
  PageLayoutMutations,
  Rect,
  ViewportDiff,
  ViewportObservation,
  ViewportProfile,
  VisualNode,
  VisualPatternInfo,
  VisualPatternType,
} from "../graph/types.js";

// Helper: parse pixel or numeric values from CSS strings
function parsePx(val?: string | null): number {
  if (!val) return 0;
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// Helper: check if a color string has transparency
function hasTransparency(color?: string | null): boolean {
  if (!color) return false;
  const c = color.trim().toLowerCase();
  if (c === "transparent") return true;
  if (c.startsWith("rgba")) {
    const parts = c.split(",");
    if (parts.length >= 4) {
      const alpha = parseFloat(parts[3]!.replace(")", "").trim());
      return !isNaN(alpha) && alpha < 0.98;
    }
  }
  if (c.startsWith("hsla")) {
    const parts = c.split(",");
    if (parts.length >= 4) {
      const alpha = parseFloat(parts[3]!.replace(")", "").trim());
      return !isNaN(alpha) && alpha < 0.98;
    }
  }
  return false;
}

// Helper: check if element is interactive
function isElementInteractive(vis: VisualNode, ax?: AxNode | null): boolean {
  if (ax) {
    const role = (ax.role ?? "").toLowerCase();
    const interactiveRoles = new Set([
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "combobox",
      "textbox",
      "spinbutton",
    ]);
    if (interactiveRoles.has(role) || ax.focusable) return true;
  }
  const cs = vis.computedStyle;
  if (cs?.cursor === "pointer") return true;
  return false;
}

/**
 * Classifies semantic visual patterns on a single VisualNode.
 */
export function classifyNodeVisualPatterns(
  vis: VisualNode,
  ax?: AxNode | null,
  viewport?: { w: number; h: number },
  allVis?: VisualNode[],
): VisualPatternInfo[] {
  const patterns: VisualPatternInfo[] = [];
  const cs = vis.computedStyle ?? {};
  const rect = vis.rect ?? { x: 0, y: 0, w: 0, h: 0 };
  const vpH = viewport?.h ?? 900;
  const vpW = viewport?.w ?? 1440;
  const pos = cs.position ?? "static";
  const isFixedOrAbsolute = pos === "fixed" || pos === "absolute";
  const isStickyOrFixed = pos === "sticky" || pos === "fixed";
  const zIdx = parsePx(cs.zIndex);
  const axRole = (ax?.role ?? "").toLowerCase();
  const axName = (ax?.name ?? "").toLowerCase();

  // 1. Floating Action Button (fab)
  const isInteractive = isElementInteractive(vis, ax);
  const isCornerOrEdge =
    rect.y + rect.h >= vpH * 0.6 &&
    (rect.x + rect.w >= vpW * 0.6 || rect.x <= vpW * 0.35);
  const isFabSized = rect.w >= 28 && rect.w <= 140 && rect.h >= 28 && rect.h <= 140;
  const hasShadow = Boolean(cs.boxShadow && cs.boxShadow !== "none");
  const hasRoundedBorder =
    parsePx(cs.borderRadius) >= 12 || (cs.borderRadius && cs.borderRadius.includes("%"));

  if (isFixedOrAbsolute && isInteractive && (isCornerOrEdge || isFabSized)) {
    const reasons: string[] = [`position:${pos}`];
    let score = 0.6;
    if (isCornerOrEdge) {
      reasons.push(`viewport offset anchored near corner (x=${Math.round(rect.x)}, y=${Math.round(rect.y)})`);
      score += 0.15;
    }
    if (isFabSized) {
      reasons.push(`compact action dimensions (${Math.round(rect.w)}×${Math.round(rect.h)}px)`);
      score += 0.1;
    }
    if (hasShadow || hasRoundedBorder) {
      reasons.push("elevated styling (shadow/pill radius)");
      score += 0.1;
    }
    if (zIdx > 0) reasons.push(`elevated z-index (${zIdx})`);
    if (score >= 0.75) {
      patterns.push({
        pattern: "fab",
        confidence: Math.min(1.0, score),
        reasons,
        metadata: { position: pos, zIndex: zIdx },
      });
    }
  }

  // 2. Modal Backdrop (modal-backdrop)
  const spansNearlyFullViewport =
    rect.w >= vpW * 0.75 && rect.h >= vpH * 0.75 && rect.x <= 30 && rect.y <= 30;
  const hasBackdropOpacity =
    parsePx(cs.opacity) < 0.98 ||
    hasTransparency(cs.backgroundColor) ||
    Boolean(cs.backdropFilter && cs.backdropFilter !== "none");

  if (isFixedOrAbsolute && spansNearlyFullViewport && (hasBackdropOpacity || zIdx >= 5)) {
    const reasons: string[] = [
      `position:${pos}`,
      `spans viewport boundary (${Math.round(rect.w)}×${Math.round(rect.h)}px)`,
    ];
    if (hasBackdropOpacity) reasons.push("semi-transparent backdrop opacity or background");
    if (zIdx > 0) reasons.push(`high stacking order zIndex=${zIdx}`);
    patterns.push({
      pattern: "modal-backdrop",
      confidence: hasBackdropOpacity ? 0.95 : 0.85,
      reasons,
    });
  }

  // 3. Dialog Overlay (dialog-overlay)
  const isExplicitDialogRole = axRole === "dialog" || axRole === "alertdialog";
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  const isCentered =
    Math.abs(centerX - vpW / 2) <= vpW * 0.25 &&
    Math.abs(centerY - vpH / 2) <= vpH * 0.25;
  const hasOverlaySize = rect.w >= 180 && rect.h >= 80 && (rect.w < vpW * 0.95 || rect.h < vpH * 0.95);

  if (isExplicitDialogRole) {
    patterns.push({
      pattern: "dialog-overlay",
      confidence: 0.98,
      reasons: [`explicit accessibility role '${axRole}'`, `dimensions: ${Math.round(rect.w)}×${Math.round(rect.h)}px`],
      metadata: { role: axRole },
    });
  } else if (isFixedOrAbsolute && isCentered && hasOverlaySize && (zIdx >= 10 || hasShadow)) {
    patterns.push({
      pattern: "dialog-overlay",
      confidence: 0.85,
      reasons: [
        `position:${pos}`,
        "centered overlay coordinates",
        hasShadow ? "elevated box-shadow" : `z-index ${zIdx}`,
      ],
    });
  }

  // 4. Sticky Header (sticky-header)
  const isAtTop = rect.y <= 20;
  const spansHorizontalWidth = rect.w >= vpW * 0.65;
  const isHeaderHeight = rect.h >= 24 && rect.h <= 260;
  if (isStickyOrFixed && isAtTop && spansHorizontalWidth && isHeaderHeight) {
    patterns.push({
      pattern: "sticky-header",
      confidence: pos === "sticky" ? 0.95 : 0.9,
      reasons: [
        `position:${pos} at top offset (y=${Math.round(rect.y)})`,
        `width spans viewport (${Math.round(rect.w)}px >= ${Math.round(vpW * 0.65)}px)`,
        `header height ${Math.round(rect.h)}px`,
      ],
    });
  }

  // 5. Sticky Footer (sticky-footer)
  const isAtBottom = rect.y + rect.h >= vpH - 40;
  const isFooterHeight = rect.h >= 24 && rect.h <= 260;
  if (isStickyOrFixed && isAtBottom && spansHorizontalWidth && isFooterHeight) {
    patterns.push({
      pattern: "sticky-footer",
      confidence: pos === "sticky" ? 0.95 : 0.9,
      reasons: [
        `position:${pos} at bottom offset (y=${Math.round(rect.y)})`,
        `width spans viewport (${Math.round(rect.w)}px)`,
        `footer height ${Math.round(rect.h)}px`,
      ],
    });
  }

  // 6. Dismiss Button (dismiss-button)
  const isCloseLabel =
    /^(close|dismiss|cancel|clear|times|exit|done|✕|✖|×|x)$/i.test(axName.trim()) ||
    /close\s+dialog|dismiss\s+dialog|close\s+modal/i.test(axName.trim());

  if (isInteractive && isCloseLabel) {
    patterns.push({
      pattern: "dismiss-button",
      confidence: 0.95,
      reasons: [`interactive element with explicit dismiss label '${axName}'`],
    });
  } else if (isInteractive && axRole === "button" && rect.w <= 50 && rect.h <= 50) {
    if (allVis) {
      const parentDialog = allVis.find(
        (other) =>
          other.id !== vis.id &&
          other.rect &&
          rect.x >= other.rect.x &&
          rect.y >= other.rect.y &&
          rect.x + rect.w <= other.rect.x + other.rect.w + 10 &&
          rect.y + rect.h <= other.rect.y + other.rect.h &&
          rect.x >= other.rect.x + other.rect.w - 60 &&
          rect.y <= other.rect.y + 60,
      );
      if (parentDialog) {
        patterns.push({
          pattern: "dismiss-button",
          confidence: 0.85,
          targetAxId: parentDialog.axId,
          reasons: ["positioned in top-right corner of overlay container"],
        });
      }
    }
  }

  // 7. Form Group (form-group)
  const isFormGroupRole = axRole === "group" || axRole === "form";
  const isFormContainerType = vis.containerType === "container" || vis.containerType === "wrapper";
  if (isFormGroupRole || isFormContainerType) {
    if (allVis) {
      const containedControls = allVis.filter((other) => {
        if (other.id === vis.id || !other.rect) return false;
        return (
          other.rect.x >= rect.x - 5 &&
          other.rect.y >= rect.y - 5 &&
          other.rect.x + other.rect.w <= rect.x + rect.w + 5 &&
          other.rect.y + other.rect.h <= rect.y + rect.h + 5
        );
      });
      if (containedControls.length >= 1 && containedControls.length <= 10) {
        const hasInputLike = containedControls.some((c) => {
          const comp = c.computedStyle;
          return comp?.cursor === "text" || isElementInteractive(c, null);
        });
        if (hasInputLike || isFormGroupRole) {
          patterns.push({
            pattern: "form-group",
            confidence: isFormGroupRole ? 0.95 : 0.85,
            reasons: [
              isFormGroupRole ? `role '${axRole}'` : `layout container '${vis.containerType}'`,
              `encloses ${containedControls.length} child controls`,
            ],
            metadata: { childCount: containedControls.length },
          });
        }
      }
    }
  }

  // 8. Toast Notification (toast-notification)
  const isAlertRole = axRole === "alert" || axRole === "status";
  if (isFixedOrAbsolute && (isAlertRole || zIdx >= 100)) {
    const isToastPosition = rect.y <= 120 || rect.y + rect.h >= vpH - 120;
    const isToastSize = rect.w >= 160 && rect.w <= 480 && rect.h >= 32 && rect.h <= 180;
    if (isToastPosition && isToastSize) {
      patterns.push({
        pattern: "toast-notification",
        confidence: isAlertRole ? 0.95 : 0.85,
        reasons: [
          `position:${pos}`,
          isAlertRole ? `role '${axRole}'` : `high z-index ${zIdx}`,
          `notification bounding box ${Math.round(rect.w)}×${Math.round(rect.h)}px`,
        ],
      });
    }
  }

  return patterns;
}

/**
 * Classifies semantic visual patterns across all nodes on a page.
 */
export function classifyPageVisualPatterns(
  nodes: VisualNode[],
  getAx: (axId: string) => AxNode | undefined,
  viewport?: { w: number; h: number },
): Map<string, VisualPatternInfo[]> {
  const resultMap = new Map<string, VisualPatternInfo[]>();
  const vp = viewport ?? { w: 1440, h: 900 };

  for (const node of nodes) {
    const ax = getAx(node.axId);
    const patterns = classifyNodeVisualPatterns(node, ax, vp, nodes);
    if (patterns.length > 0) {
      resultMap.set(node.id, patterns);
      node.patterns = patterns;
      node.primaryPattern = patterns[0]!.pattern;
    }
  }

  return resultMap;
}


/**
 * Classifies the responsive layout mutation between two viewport observations of an element.
 */
export function classifyLayoutMutation(
  fromObs: ViewportObservation,
  toObs: ViewportObservation,
  options?: {
    fromSiblings?: ViewportObservation[];
    toSiblings?: ViewportObservation[];
  },
): LayoutMutation {
  const fromVis = fromObs.visibility;
  const toVis = toObs.visibility;
  const fromRect = fromObs.rect ?? { x: 0, y: 0, w: 0, h: 0 };
  const toRect = toObs.rect ?? { x: 0, y: 0, w: 0, h: 0 };

  const isFromVisible = fromVis === "visible" && fromRect.w > 0 && fromRect.h > 0;
  const isToVisible =
    toVis === "visible" &&
    toRect.w > 0 &&
    toRect.h > 0 &&
    toObs.computedStyle?.display !== "none" &&
    toObs.computedStyle?.visibility !== "hidden";

  // 1. Hide: visible at baseline, hidden or zero size at target
  if (isFromVisible && !isToVisible) {
    return {
      type: "hide",
      reasons: [
        `Element visibility changed from ${fromVis} to ${toVis} (${fromRect.w}×${fromRect.h}px → ${toRect.w}×${toRect.h}px)`,
      ],
      severity: "high",
    };
  }

  // 2. Show: not visible at baseline, visible at target
  if (!isFromVisible && isToVisible) {
    return {
      type: "show",
      reasons: [
        `Element became visible (${toVis}, ${toRect.w}×${toRect.h}px at ${toObs.viewport.name})`,
      ],
      severity: "high",
    };
  }

  // If neither was visible, mutation is unchanged
  if (!isFromVisible && !isToVisible) {
    return {
      type: "unchanged",
      reasons: ["Element remains invisible or offscreen in both viewports"],
      severity: "none",
    };
  }

  // 3. Compute geometric and structural changes
  const dw = toRect.w - fromRect.w;
  const dh = toRect.h - fromRect.h;
  const dx = toRect.x - fromRect.x;
  const dy = toRect.y - fromRect.y;
  const widthPercentChange = fromRect.w > 0 ? (dw / fromRect.w) * 100 : 0;
  const heightPercentChange = fromRect.h > 0 ? (dh / fromRect.h) * 100 : 0;

  const reasons: string[] = [];

  const fromFlexDir = fromObs.computedStyle?.["flex-direction"];
  const toFlexDir = toObs.computedStyle?.["flex-direction"];
  const isFlexDirectionShift = Boolean(fromFlexDir && toFlexDir && fromFlexDir !== toFlexDir);

  const fromGridCols = fromObs.computedStyle?.["grid-template-columns"];
  const toGridCols = toObs.computedStyle?.["grid-template-columns"];
  const isGridColsShift = Boolean(fromGridCols && toGridCols && fromGridCols !== toGridCols);

  const fromDisplay = fromObs.computedStyle?.display;
  const toDisplay = toObs.computedStyle?.display;
  const isDisplayShift = Boolean(fromDisplay && toDisplay && fromDisplay !== toDisplay);

  if (isFlexDirectionShift) reasons.push(`flex-direction reflow: '${fromFlexDir}' → '${toFlexDir}'`);
  if (isGridColsShift) reasons.push(`grid columns reflow: '${fromGridCols}' → '${toGridCols}'`);
  if (isDisplayShift) reasons.push(`display reflow: '${fromDisplay}' → '${toDisplay}'`);

  const hasStructuralShift = isFlexDirectionShift || isGridColsShift || isDisplayShift;
  const isDimensionReflow = Math.abs(widthPercentChange) >= 15 || Math.abs(heightPercentChange) >= 15;

  // 4. Reorder: check visual order inversion relative to siblings if available
  if (options?.fromSiblings && options?.toSiblings && options.fromSiblings.length > 1) {
    const fromIndex = options.fromSiblings.findIndex((s) => s.rect.y === fromRect.y && s.rect.x === fromRect.x);
    const toIndex = options.toSiblings.findIndex((s) => s.rect.y === toRect.y && s.rect.x === toRect.x);
    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      return {
        type: "reorder",
        reasons: [`Visual sibling sequence changed from index ${fromIndex} to ${toIndex}`],
        severity: "high",
      };
    }
  }

  // 5. Reflow
  if (hasStructuralShift || isDimensionReflow) {
    const signW = dw >= 0 ? `+${dw}` : `${dw}`;
    const signH = dh >= 0 ? `+${dh}` : `${dh}`;
    reasons.push(
      `Dimension delta: ${signW}px (${widthPercentChange.toFixed(1)}% w), ${signH}px (${heightPercentChange.toFixed(1)}% h)`,
    );
    const severity =
      Math.abs(widthPercentChange) > 50 || Math.abs(heightPercentChange) > 50 || hasStructuralShift
        ? "high"
        : "medium";

    return { type: "reflow", reasons, severity };
  }

  // 6. Reposition
  if (Math.abs(dx) >= 10 || Math.abs(dy) >= 10) {
    const signX = dx >= 0 ? `+${dx}` : `${dx}`;
    const signY = dy >= 0 ? `+${dy}` : `${dy}`;
    return {
      type: "reposition",
      reasons: [`Position translated by dx=${signX}px, dy=${signY}px with stable dimensions`],
      severity: Math.abs(dx) > 100 || Math.abs(dy) > 100 ? "medium" : "low",
    };
  }

  // 7. Unchanged
  return {
    type: "unchanged",
    reasons: ["Geometry, visibility, and layout properties preserved within tolerance"],
    severity: "none",
  };
}


/**
 * Computes page-level layout mutation analysis across two viewports.
 */
export function computePageLayoutMutations(
  pageId: string,
  fromViewport: ViewportProfile,
  toViewport: ViewportProfile,
  elementDiffs: Array<{ axId: string; diff: ViewportDiff; mutation: LayoutMutation }>,
): PageLayoutMutations {
  let reflowCount = 0;
  let hideCount = 0;
  let showCount = 0;
  let reorderCount = 0;
  let repositionCount = 0;
  let unchangedCount = 0;

  for (const { mutation } of elementDiffs) {
    switch (mutation.type) {
      case "reflow":
        reflowCount++;
        break;
      case "hide":
        hideCount++;
        break;
      case "show":
        showCount++;
        break;
      case "reorder":
        reorderCount++;
        break;
      case "reposition":
        repositionCount++;
        break;
      case "unchanged":
        unchangedCount++;
        break;
    }
  }

  const parts: string[] = [];
  parts.push(
    `Breakpoint transition from ${fromViewport.name}(${fromViewport.w}px) to ${toViewport.name}(${toViewport.w}px)`,
  );
  if (reflowCount > 0) parts.push(`${reflowCount} reflowed`);
  if (hideCount > 0) parts.push(`${hideCount} hidden`);
  if (showCount > 0) parts.push(`${showCount} shown`);
  if (reorderCount > 0) parts.push(`${reorderCount} reordered`);
  if (repositionCount > 0) parts.push(`${repositionCount} repositioned`);
  if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);

  const breakpointDescription = parts.join(", ") + ".";

  return {
    pageId,
    fromViewport,
    toViewport,
    mutations: elementDiffs,
    summary: {
      reflowCount,
      hideCount,
      showCount,
      reorderCount,
      repositionCount,
      unchangedCount,
      totalElements: elementDiffs.length,
    },
    breakpointDescription,
  };
}

