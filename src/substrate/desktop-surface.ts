/**
 * Desktop Substrate Surface & Session — NexusOS (Phase D2).
 *
 * Implements SubstrateSurface and SubstrateSession for native Windows (Direct UIA v3 COM)
 * and macOS (AXUIElement / Quartz) desktop platforms.
 */
import type { Source } from "../bidi-client/input.js";
import type { AxTreeNode } from "../extract-structure/structural.js";
import type {
  SubstrateSurface,
  SubstrateSession,
  SubstrateKind,
  DisplayMetrics,
} from "./types.js";
import {
  normalizeWindowsUIANode,
  normalizeMacOSAXNode,
  type RawWindowsUIANode,
  type RawMacOSAXNode,
} from "./desktop-normalizer.js";
import type { VisualNode, ViewportProfile, AxNode } from "../graph/types.js";
import { classifyNodeVisualPatterns } from "../extract-visual/patterns.js";

export interface DesktopDriverClient {
  getAccessibilityTree(): Promise<RawWindowsUIANode | RawMacOSAXNode>;
  takeScreenshot(): Promise<string>;
  performInputActions?(actions: Source[]): Promise<void>;
  getActiveWindowBounds?(): Promise<{ x: number; y: number; width: number; height: number }>;
  getActiveWindowTitle?(): Promise<string>;
  getActiveProcessName?(): Promise<string>;
  closeSession(): Promise<void>;
}

export class DesktopSubstrateSurface implements SubstrateSurface {
  readonly substrateKind: SubstrateKind;
  readonly surfaceId: string;

  constructor(
    kind: "desktop-windows" | "desktop-macos",
    surfaceId: string,
    private readonly client: DesktopDriverClient,
  ) {
    this.substrateKind = kind;
    this.surfaceId = surfaceId;
  }

  async getRoute(): Promise<string> {
    const process = this.client.getActiveProcessName
      ? await this.client.getActiveProcessName()
      : "desktop-app";
    return `desktop://${this.substrateKind}/${process}/${this.surfaceId}`;
  }

  async getTitle(): Promise<string> {
    if (this.client.getActiveWindowTitle) {
      return await this.client.getActiveWindowTitle();
    }
    return this.surfaceId;
  }

  async captureScreenshot(): Promise<{ data: Buffer; mimeType: string }> {
    const base64 = await this.client.takeScreenshot();
    return {
      data: Buffer.from(base64, "base64"),
      mimeType: "image/png",
    };
  }

  async extractAccessibilityTree(): Promise<AxTreeNode[]> {
    const raw = await this.client.getAccessibilityTree();
    if (!raw) return [];
    if (this.substrateKind === "desktop-windows") {
      const node = normalizeWindowsUIANode(raw as RawWindowsUIANode);
      return [node];
    } else {
      const node = normalizeMacOSAXNode(raw as RawMacOSAXNode);
      return [node];
    }
  }

  async performActions(actions: Source[]): Promise<void> {
    if (this.client.performInputActions) {
      await this.client.performInputActions(actions);
    }
  }

  async getDisplayMetrics(): Promise<DisplayMetrics> {
    const rawBounds = this.client.getActiveWindowBounds ? await this.client.getActiveWindowBounds() : null;
    const bounds = (rawBounds && typeof rawBounds.width === "number") ? rawBounds : { x: 0, y: 0, width: 1920, height: 1080 };

    const orientation = bounds.width >= bounds.height ? "landscape" : "portrait";
    return {
      width: bounds.width,
      height: bounds.height,
      density: 1.5,
      orientation,
      safeAreaInsets: { top: 32, bottom: 40, left: 0, right: 0 },
    };
  }

  async extractVisualNodes(pageId: string): Promise<VisualNode[]> {
    const raw = await this.client.getAccessibilityTree();
    if (!raw) return [];
    const metrics = await this.getDisplayMetrics();
    const vp: ViewportProfile = {
      name: "desktop",
      w: metrics.width,
      h: metrics.height,
      dpr: metrics.density,
    };
    const nodes: VisualNode[] = [];
    let counter = 0;

    const traverseWindows = (node: RawWindowsUIANode, parentVisId: string | null) => {
      const axId = node.automationId ? `ax:${node.automationId}` : `ax:win-${counter++}`;
      const visId = `vis:${pageId}:${axId}`;
      const rect = node.boundingRectangle
        ? { x: node.boundingRectangle.x, y: node.boundingRectangle.y, w: node.boundingRectangle.width, h: node.boundingRectangle.height }
        : { x: 0, y: 0, w: 0, h: 0 };
      const childCount = node.children ? node.children.length : 0;
      const isContainer = childCount > 0;
      const isButton = (node.controlType ?? "").toLowerCase().includes("button");
      const isBottomRight = (rect.x + rect.w >= vp.w * 0.7) && (rect.y + rect.h >= vp.h * 0.7);
      const isFabCandidate = isButton && isBottomRight && rect.w >= 28 && rect.w <= 120 && rect.h >= 28 && rect.h <= 120;
      const compStyle: Record<string, string> = {
        display: isContainer ? "flex" : "block",
        visibility: node.isOffscreen ? "hidden" : "visible",
        position: isFabCandidate ? "fixed" : "relative",
        cursor: (isButton || isFabCandidate) ? "pointer" : "default",
        boxShadow: isFabCandidate ? "0 4px 8px rgba(0,0,0,0.3)" : "none",
        borderRadius: isFabCandidate ? "50%" : "0px",
      };

      const vis: VisualNode = {
        id: visId,
        type: "visual-node",
        axId,
        pageId,
        rect,
        computedStyle: compStyle,
        designTokenRefs: [],
        tethers: {
          parent: parentVisId,
          children: [],
          siblingsBefore: [],
          siblingsAfter: [],
          anchors: [],
        },
        provenance: "desktop:windows-uia",
        viewport: vp,
        isVisualContainer: isContainer,
        containerType: isContainer ? "flex" : undefined,
      };

      const syntheticAx: AxNode = {
        id: axId,
        type: "ax-node",
        pageId,
        role: (isButton ? "button" : "generic") as any,
        name: node.name ?? "",
        nameSource: "attribute",
        states: {} as any,
        properties: {} as any,
        apgPattern: null,
        focusable: isButton,
        visibility: "visible",
        inPageDomOrder: counter,
        parentAxId: null,
        provenance: "desktop:windows-uia",
      };

      const patterns = classifyNodeVisualPatterns(vis, syntheticAx, vp);
      if (patterns.length > 0) {
        vis.patterns = patterns;
        vis.primaryPattern = patterns[0]?.pattern;
      }
      nodes.push(vis);

      if (node.children) {
        for (const child of node.children) {
          traverseWindows(child, visId);
        }
      }
    };

    const traverseMac = (node: RawMacOSAXNode, parentVisId: string | null) => {
      const axId = node.identifier ? `ax:${node.identifier}` : `ax:mac-${counter++}`;
      const visId = `vis:${pageId}:${axId}`;
      const rect = node.frame
        ? { x: node.frame.x, y: node.frame.y, w: node.frame.width, h: node.frame.height }
        : { x: 0, y: 0, w: 0, h: 0 };
      const childCount = node.children ? node.children.length : 0;
      const isContainer = childCount > 0;
      const isButton = (node.role ?? "").toLowerCase().includes("button");
      const isBottomRight = (rect.x + rect.w >= vp.w * 0.7) && (rect.y + rect.h >= vp.h * 0.7);
      const isFabCandidate = isButton && isBottomRight && rect.w >= 28 && rect.w <= 120 && rect.h >= 28 && rect.h <= 120;
      const compStyle: Record<string, string> = {
        display: isContainer ? "flex" : "block",
        visibility: "visible",
        position: isFabCandidate ? "fixed" : "relative",
        cursor: (isButton || isFabCandidate) ? "pointer" : "default",
        boxShadow: isFabCandidate ? "0 4px 8px rgba(0,0,0,0.3)" : "none",
        borderRadius: isFabCandidate ? "50%" : "0px",
      };

      const vis: VisualNode = {
        id: visId,
        type: "visual-node",
        axId,
        pageId,
        rect,
        computedStyle: compStyle,
        designTokenRefs: [],
        tethers: {
          parent: parentVisId,
          children: [],
          siblingsBefore: [],
          siblingsAfter: [],
          anchors: [],
        },
        provenance: "desktop:macos-ax",
        viewport: vp,
        isVisualContainer: isContainer,
        containerType: isContainer ? "flex" : undefined,
      };

      const syntheticAx: AxNode = {
        id: axId,
        type: "ax-node",
        pageId,
        role: (isButton ? "button" : "generic") as any,
        name: node.title ?? "",
        nameSource: "attribute",
        states: {} as any,
        properties: {} as any,
        apgPattern: null,
        focusable: isButton,
        visibility: "visible",
        inPageDomOrder: counter,
        parentAxId: null,
        provenance: "desktop:macos-ax",
      };

      const patterns = classifyNodeVisualPatterns(vis, syntheticAx, vp);
      if (patterns.length > 0) {
        vis.patterns = patterns;
        vis.primaryPattern = patterns[0]?.pattern;
      }
      nodes.push(vis);

      if (node.children) {
        for (const child of node.children) {
          traverseMac(child, visId);
        }
      }
    };

    if (this.substrateKind === "desktop-windows") {
      traverseWindows(raw as RawWindowsUIANode, null);
    } else {
      traverseMac(raw as RawMacOSAXNode, null);
    }

    return nodes;
  }
}

export class DesktopSubstrateSession implements SubstrateSession {
  readonly substrateKind: SubstrateKind;
  readonly sessionId: string;

  constructor(
    kind: "desktop-windows" | "desktop-macos",
    sessionId: string,
    private readonly client: DesktopDriverClient,
  ) {
    this.substrateKind = kind;
    this.sessionId = sessionId;
  }

  async newSurface(): Promise<SubstrateSurface> {
    return new DesktopSubstrateSurface(
      this.substrateKind as "desktop-windows" | "desktop-macos",
      `window:${this.sessionId}:${Date.now()}`,
      this.client,
    );
  }

  async close(): Promise<void> {
    await this.client.closeSession();
  }
}
