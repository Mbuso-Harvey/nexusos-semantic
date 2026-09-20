/**
 * Mobile Substrate Surface & Session — NexusOS (Phase M2).
 *
 * Implements SubstrateSurface and SubstrateSession for native Android (UIAutomator2)
 * and iOS (WebDriverAgent / XCUITest) devices.
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
  normalizeAndroidNode,
  normalizeIOSNode,
  type RawAndroidNode,
  type RawIOSNode,
} from "./mobile-normalizer.js";
import type { VisualNode, ViewportProfile, AxNode } from "../graph/types.js";
import { classifyNodeVisualPatterns } from "../extract-visual/patterns.js";

export interface MobileDriverClient {
  getPageSource(): Promise<string | RawAndroidNode | RawIOSNode>;
  takeScreenshot(): Promise<string>;
  performTouchActions?(actions: Source[]): Promise<void>;
  getWindowRect?(): Promise<{ width: number; height: number }>;
  getCurrentActivityOrRoute?(): Promise<string>;
  closeSession(): Promise<void>;
}

export class MobileSubstrateSurface implements SubstrateSurface {
  readonly substrateKind: SubstrateKind;
  readonly surfaceId: string;

  constructor(
    kind: "mobile-android" | "mobile-ios",
    surfaceId: string,
    private readonly client: MobileDriverClient,
  ) {
    this.substrateKind = kind;
    this.surfaceId = surfaceId;
  }

  async getRoute(): Promise<string> {
    if (this.client.getCurrentActivityOrRoute) {
      return await this.client.getCurrentActivityOrRoute();
    }
    return `mobile://${this.substrateKind}/${this.surfaceId}`;
  }

  async getTitle(): Promise<string> {
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
    const raw = await this.client.getPageSource();
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return this.normalizeTree(parsed);
      } catch {
        return [];
      }
    }
    return this.normalizeTree(raw);
  }

  private normalizeTree(raw: any): AxTreeNode[] {
    if (!raw) return [];
    if (this.substrateKind === "mobile-android") {
      const node = normalizeAndroidNode(raw as RawAndroidNode);
      return [node];
    } else {
      const node = normalizeIOSNode(raw as RawIOSNode);
      return [node];
    }
  }

  async performActions(actions: Source[]): Promise<void> {
    if (this.client.performTouchActions) {
      await this.client.performTouchActions(actions);
    }
  }

  async getDisplayMetrics(): Promise<DisplayMetrics> {
    const rect = this.client.getWindowRect
      ? await this.client.getWindowRect()
      : { width: 1080, height: 2400 };

    const orientation = rect.width >= rect.height ? "landscape" : "portrait";
    return {
      width: rect.width,
      height: rect.height,
      density: 3,
      orientation,
      safeAreaInsets: { top: 48, bottom: 34, left: 0, right: 0 },
    };
  }

  async extractVisualNodes(pageId: string): Promise<VisualNode[]> {
    const rawTree = await this.client.getPageSource();
    let parsed: any = rawTree;
    if (typeof rawTree === "string") {
      try {
        parsed = JSON.parse(rawTree);
      } catch {
        return [];
      }
    }
    if (!parsed) return [];

    const metrics = await this.getDisplayMetrics();
    const vp: ViewportProfile = {
      name: "mobile",
      w: metrics.width,
      h: metrics.height,
      dpr: metrics.density,
    };
    const nodes: VisualNode[] = [];
    let counter = 0;

    const traverseAndroid = (node: RawAndroidNode, parentVisId: string | null) => {
      const axId = node.resourceId ? `ax:${node.resourceId}` : `ax:droid-${counter++}`;
      const visId = `vis:${pageId}:${axId}`;
      let rect = { x: 0, y: 0, w: 0, h: 0 };
      if (node.bounds) {
        rect = {
          x: node.bounds.left,
          y: node.bounds.top,
          w: Math.max(0, node.bounds.right - node.bounds.left),
          h: Math.max(0, node.bounds.bottom - node.bounds.top),
        };
      }
      const childCount = node.children ? node.children.length : 0;
      const isContainer = childCount > 0;
      const cls = (node.className ?? "").toLowerCase();
      const isButton = Boolean(node.clickable || cls.includes("button"));
      const isBottomRight = (rect.x + rect.w >= vp.w * 0.7) && (rect.y + rect.h >= vp.h * 0.7);
      const isFabCandidate = isButton && isBottomRight && rect.w >= 28 && rect.w <= 140 && rect.h >= 28 && rect.h <= 140;

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
        provenance: "mobile:android-uia2",
        viewport: vp,
        isVisualContainer: isContainer,
        containerType: isContainer ? "flex" : undefined,
      };

      const syntheticAx: AxNode = {
        id: axId,
        type: "ax-node",
        pageId,
        role: (isButton ? "button" : "generic") as any,
        name: node.contentDescription ?? node.text ?? "",
        nameSource: "attribute",
        states: {} as any,
        properties: {} as any,
        apgPattern: null,
        focusable: Boolean(node.focused || node.clickable),
        visibility: "visible",
        inPageDomOrder: counter,
        parentAxId: null,
        provenance: "mobile:android-uia2",
      };

      const patterns = classifyNodeVisualPatterns(vis, syntheticAx, vp);
      if (patterns.length > 0) {
        vis.patterns = patterns;
        vis.primaryPattern = patterns[0]?.pattern;
      }
      nodes.push(vis);

      if (node.children) {
        for (const child of node.children) {
          traverseAndroid(child, visId);
        }
      }
    };

    const traverseIOS = (node: RawIOSNode, parentVisId: string | null) => {
      const axId = node.identifier ? `ax:${node.identifier}` : `ax:ios-${counter++}`;
      const visId = `vis:${pageId}:${axId}`;
      const rect = node.frame
        ? { x: node.frame.x, y: node.frame.y, w: node.frame.width, h: node.frame.height }
        : { x: 0, y: 0, w: 0, h: 0 };
      const childCount = node.children ? node.children.length : 0;
      const isContainer = childCount > 0;
      const typeStr = (node.type ?? "").toLowerCase();
      const isButton = typeStr.includes("button");
      const isBottomRight = (rect.x + rect.w >= vp.w * 0.7) && (rect.y + rect.h >= vp.h * 0.7);
      const isFabCandidate = isButton && isBottomRight && rect.w >= 28 && rect.w <= 140 && rect.h >= 28 && rect.h <= 140;

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
        provenance: "mobile:ios-xcui",
        viewport: vp,
        isVisualContainer: isContainer,
        containerType: isContainer ? "flex" : undefined,
      };

      const syntheticAx: AxNode = {
        id: axId,
        type: "ax-node",
        pageId,
        role: (isButton ? "button" : "generic") as any,
        name: node.label ?? node.title ?? "",
        nameSource: "attribute",
        states: {} as any,
        properties: {} as any,
        apgPattern: null,
        focusable: isButton,
        visibility: "visible",
        inPageDomOrder: counter,
        parentAxId: null,
        provenance: "mobile:ios-xcui",
      };

      const patterns = classifyNodeVisualPatterns(vis, syntheticAx, vp);
      if (patterns.length > 0) {
        vis.patterns = patterns;
        vis.primaryPattern = patterns[0]?.pattern;
      }
      nodes.push(vis);

      if (node.children) {
        for (const child of node.children) {
          traverseIOS(child, visId);
        }
      }
    };

    if (this.substrateKind === "mobile-android") {
      traverseAndroid(parsed as RawAndroidNode, null);
    } else {
      traverseIOS(parsed as RawIOSNode, null);
    }

    return nodes;
  }
}

export class MobileSubstrateSession implements SubstrateSession {
  readonly substrateKind: SubstrateKind;
  readonly sessionId: string;

  constructor(
    kind: "mobile-android" | "mobile-ios",
    sessionId: string,
    private readonly client: MobileDriverClient,
  ) {
    this.substrateKind = kind;
    this.sessionId = sessionId;
  }

  async newSurface(): Promise<SubstrateSurface> {
    return new MobileSubstrateSurface(
      this.substrateKind as "mobile-android" | "mobile-ios",
      `surface:${this.sessionId}:${Date.now()}`,
      this.client,
    );
  }

  async close(): Promise<void> {
    await this.client.closeSession();
  }
}
