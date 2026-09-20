/**
 * Universal Substrate Interface (USI) — NexusOS.
 *
 * Defines platform-agnostic abstractions across Web (WebDriver BiDi)
 * and Native Mobile (Android UIAutomator2, iOS XCUITest/WDA).
 */
import type { AxTreeNode } from "../extract-structure/structural.js";
import type { Source } from "../bidi-client/input.js";
import type { VisualNode } from "../graph/types.js";

export type SubstrateKind =
  | "web-bidi"
  | "web-cdp"
  | "mobile-android"
  | "mobile-ios"
  | "desktop-windows"
  | "desktop-macos";

/**
 * The family a substrate belongs to — used by capability discovery so an
 * orchestration layer can plan across Web / Desktop / Mobile without
 * hardcoding which concrete engine is attached.
 */
export type SubstrateFamily = "web" | "desktop" | "mobile";

/**
 * A single interactive endpoint reachable through a substrate: a browser tab,
 * a desktop window, or an attached device. Emitted by capability discovery
 * so an agent can pick targets without knowing the driver internals.
 */
export interface SubstrateTargetInfo {
  /** Opaque target id (CDP target id / window handle / adb serial / BiDi context). */
  id: string;
  /** Human label: tab title, window title, or device model. */
  label: string;
  /** Route when known: URL, activity, or desktop:// route. */
  route?: string;
}

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface DisplayMetrics {
  /** Screen or viewport width in points / dp */
  width: number;
  /** Screen or viewport height in points / dp */
  height: number;
  /** Pixel density ratio (@1x, @2x, @3x or mdpi/xxhdpi) */
  density: number;
  /** Physical device orientation */
  orientation: "portrait" | "landscape";
  /** Insets covering notch, Dynamic Island, status bar, and home indicator */
  safeAreaInsets: SafeAreaInsets;
}

/**
 * Universal contract for an interactive surface (Web Page / Mobile Screen).
 */
export interface SubstrateSurface {
  /** Discriminator identifying the underlying runtime environment */
  readonly substrateKind: SubstrateKind;
  /** Unique surface identifier (BiDi tab context id, Android Activity token, or iOS window handle) */
  readonly surfaceId: string;

  /** Resolved route (Web URL or Mobile Activity/Fragment/SwiftUI screen identifier) */
  getRoute(): Promise<string>;
  /** Title or topmost accessible header */
  getTitle(): Promise<string>;

  /** Capture pixel-truth screenshot */
  captureScreenshot(): Promise<{ data: Buffer; mimeType: string }>;

  /** Extract normalized structural accessibility tree */
  extractAccessibilityTree(): Promise<AxTreeNode[]>;

  /** Perform W3C-standard input actions (pointer/touch/key) */
  performActions(actions: Source[]): Promise<void>;

  /** Get active display bounds and insets */
  getDisplayMetrics(): Promise<DisplayMetrics>;

  /** Extract visual intelligence nodes (VI-05 cross-substrate visual parity) */
  extractVisualNodes?(pageId: string): Promise<VisualNode[]>;
}

/**
 * Session contract managing the lifecycle of an attached browser or mobile device daemon.
 */
export interface SubstrateSession {
  readonly sessionId: string;
  readonly substrateKind: SubstrateKind;

  /** Create or attach to a new interactive surface */
  newSurface(): Promise<SubstrateSurface>;

  /** Gracefully terminate connection and release hardware/process locks */
  close(): Promise<void>;
}
