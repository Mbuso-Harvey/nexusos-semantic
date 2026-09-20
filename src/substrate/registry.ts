/**
 * Substrate Provider Registry — NexusOS.
 *
 * The capability-discovery and surface-resolution backbone that lets one
 * substrate-neutral MCP surface reach every substrate Nexus already
 * implements: Firefox/BiDi, Chrome/CDP, Windows/UIA, macOS/AX,
 * Android/ADB+UIAutomator2, and iOS/WDA.
 *
 * Design rule (executive decision "Expose, don't rebuild"): this registry only
 * ADAPTS existing clients (BiDiSession/Page, ChromeCdpClient, WindowsUiaDaemon,
 * MacOSAxDaemon, AndroidClient, WdaClient) behind the existing universal
 * contracts (`SubstrateSurface`, `MobileDriverClient`, `DesktopDriverClient`).
 * No automation engine is implemented here.
 *
 * Three responsibilities:
 *   1. `discover()` — probe every supported substrate and report what is
 *      actually available on this host right now (P5 capability discovery).
 *   2. `resolveSurface(kind, target)` — turn a substrate kind + target into a
 *      live `SubstrateSurface` (tab / window / device).
 *   3. `performAction` / `navigate` — dispatch the universal kinetic action
 *      vocabulary onto the right concrete driver path.
 */
import type { BiDiSession, Page } from "../bidi-client/index.js";
import type { ChromeCdpClient, CdpTarget } from "../desktop/chrome-cdp.js";
import { ChromeCdpClient as ChromeCdpClientCtor } from "../desktop/chrome-cdp.js";
import { WindowsUiaDaemon } from "../desktop/windows/uia-daemon.js";
import { MacOSAxDaemon } from "../desktop/macos/ax-daemon.js";
import { AndroidClient } from "../mobile/android/uia2-client.js";
import { WdaClient } from "../mobile/ios/wda-client.js";
import type { Source } from "../bidi-client/input.js";
import { WebBiDiSurface } from "./web-adapter.js";
import { WebCdpSurface } from "./web-cdp-surface.js";
import { MobileSubstrateSurface } from "./mobile-surface.js";
import type { SubstrateSurface, SubstrateKind, SubstrateFamily, SubstrateTargetInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Structural contracts for the concrete drivers the registry may touch.
// All extra members are optional so both drivers in a family satisfy them.
// ---------------------------------------------------------------------------

// Re-export the canonical window descriptor from the UIA daemon rather than
// duplicating it (both were `export interface DesktopWindowInfo`, which made
// the barrel's star-exports ambiguous, TS2308).
import type { DesktopWindowInfo } from "../desktop/windows/uia-daemon.js";
export type { DesktopWindowInfo };
/** A mobile device as reported by `adb devices -l` (Android) or WDA status (iOS). */
export interface MobileDeviceInfo {
  id: string;
  state?: string;
  model?: string;
  device?: string;
}

/** The concrete desktop daemon surface the registry uses (UIA bridge or AX daemon). */
export interface DesktopKineticDaemon {
  listWindows(): Promise<DesktopWindowInfo[]>;
  createSurface(target?: { titlePattern?: string; windowId?: string } | string): Promise<SubstrateSurface>;
  dispatchKineticAction?(action: Record<string, unknown>): Promise<void>;
  focusWindow?(windowId: string): Promise<void>;
  sendHotkey?(hotkey: string): Promise<void>;
  performInputActions?(actions: Source[]): Promise<void>;
  activateApplication?(processName: string): Promise<void>;
}

/** The concrete mobile client surface the registry uses (AndroidClient or WdaClient). */
export interface MobileKineticClient {
  getPageSource(): Promise<unknown>;
  takeScreenshot(): Promise<string>;
  performTouchActions?(actions: Source[]): Promise<void>;
  getWindowRect?(): Promise<{ width: number; height: number }>;
  getCurrentActivityOrRoute?(): Promise<string>;
  closeSession(): Promise<void>;
  listDevices?(): Promise<MobileDeviceInfo[]>;
  setDevice?(deviceId: string): void;
  tap?(x: number, y: number): Promise<void>;
  swipe?(x1: number, y1: number, x2: number, y2: number, duration?: number): Promise<void>;
  typeText?(text: string): Promise<void>;
  keyevent?(keyCode: number): Promise<void>;
  pressHome?(): Promise<void>;
  launchApp?(appId: string): Promise<void>;
  activateApp?(appId: string): Promise<void>;
  terminateApp?(appId: string): Promise<boolean>;
}

/** An attached desktop substrate: which kind + the daemon instance. */
export interface DesktopSubstrateHandle {
  kind: "desktop-windows" | "desktop-macos";
  daemon: DesktopKineticDaemon;
}

/** An attached mobile substrate: which kind + the driver client instance. */
export interface MobileSubstrateHandle {
  kind: "mobile-android" | "mobile-ios";
  client: MobileKineticClient;
}

// ---------------------------------------------------------------------------
// Discovery types
// ---------------------------------------------------------------------------

/** What one substrate supports, for an agent to plan against (P5). */
export interface SubstrateProviderStatus {
  kind: SubstrateKind;
  family: SubstrateFamily;
  /** Human label, e.g. "Firefox (WebDriver BiDi)". */
  label: string;
  available: boolean;
  /** Why not, when unavailable ("disabled — enable with --mobile=android"). */
  reason?: string;
  /** How it is attached ("adb device emulator-5554", "7 windows", "attached tab ..."). */
  detail?: string;
  /** Live targets (tabs / windows / devices) when discovery found them. */
  targets?: SubstrateTargetInfo[];
  /** Capability tokens this substrate supports through the universal tools. */
  capabilities: string[];
}

export interface SubstrateDiscoveryReport {
  protocol: "nexus-substrates/1";
  /** Kinds that are usable right now. */
  available: SubstrateKind[];
  substrates: SubstrateProviderStatus[];
  /** Human-readable report in the documented discovery format. */
  report: string;
}

/** Selector for a single interactive surface. All fields optional; substrate-specific. */
export interface SurfaceTarget {
  urlPattern?: string;
  targetId?: string;
  deviceId?: string;
  windowId?: string;
  titlePattern?: string;
}

/** The universal kinetic action vocabulary (translated per substrate). */

// ---------------------------------------------------------------------------
// Key translation tables (universal vocabulary → concrete driver codes)
// ---------------------------------------------------------------------------

/** Android keyevent codes for the universal `key` action. */
const ANDROID_KEYCODES: Readonly<Record<string, number>> = Object.freeze({
  home: 3,
  back: 4,
  enter: 66,
  tab: 61,
  delete: 67,
  "page-up": 92,
  "page-down": 93,
  "volume-up": 24,
  "volume-down": 25,
});

/** iOS WDA key names for the universal `key` action. */
const IOS_KEYNAMES: Readonly<Record<string, string>> = Object.freeze({
  enter: "\r",
  tab: "\t",
  delete: "\b",
});

/** Shared capability tokens per family (what the universal tools promise). */
const FAMILY_CAPABILITIES: Readonly<Record<SubstrateFamily, string[]>> = Object.freeze({
  web: ["discover", "inspect", "screenshot", "read-state", "navigate", "click", "type", "key", "scroll", "verify"],
  desktop: ["discover", "inspect", "screenshot", "read-state", "click", "type", "key", "activate-app", "verify"],
  mobile: ["discover", "inspect", "screenshot", "read-state", "navigate", "launch-app", "tap", "type", "key", "swipe", "verify"],
});

function kindFamily(kind: SubstrateKind): SubstrateFamily {
  if (kind === "web-bidi" || kind === "web-cdp") return "web";
  if (kind === "desktop-windows" || kind === "desktop-macos") return "desktop";
  return "mobile";
}

function kindLabel(kind: SubstrateKind): string {
  switch (kind) {
    case "web-bidi": return "Firefox (WebDriver BiDi)";
    case "web-cdp": return "Chrome (DevTools Protocol)";
    case "desktop-windows": return "Windows (UI Automation)";
    case "desktop-macos": return "macOS (Accessibility API)";
    case "mobile-android": return "Android (ADB + UIAutomator2)";
    case "mobile-ios": return "iOS (WebDriverAgent)";
  }
}

/** Run a probe with a hard timeout so discovery never hangs on a stuck driver. */
async function withTimeout<T>(ms: number, label: string, job: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      job(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface SubstrateRegistryDeps {
  /** Server-owned BiDi session (Firefox), when attached. */
  bidi?: BidiSessionHandle | null;
  /** Chrome CDP client, when enabled. */
  chrome?: ChromeCdpClient | null;
  /** Attached desktop substrate (Windows UIA or macOS AX). */
  desktop?: DesktopSubstrateHandle | null;
  /** Attached mobile substrate (Android or iOS). */
  mobile?: MobileSubstrateHandle | null;
  /** Hard cap for any single probe (default 4000ms). */
  probeTimeoutMs?: number;
}

export class SubstrateProviderRegistry {
  private readonly probeMs: number;

  constructor(private readonly deps: SubstrateRegistryDeps = {}) {
    this.probeMs = deps.probeTimeoutMs ?? 4000;
  }

  // ---- P5: capability discovery ------------------------------------------

  /**
   * Probe all six supported substrates. Attached substrates are probed through
   * their live handle; unattached ones get a lightweight host probe (is the
   * platform right, is the driver reachable) so an orchestration layer can
   * distinguish "disabled by the operator" from "unavailable on this host".
   */
  async discover(): Promise<SubstrateDiscoveryReport> {
    const substrates = await Promise.all([
      this.probeWebBidi(),
      this.probeWebCdp(),
      this.probeDesktop("desktop-windows"),
      this.probeDesktop("desktop-macos"),
      this.probeMobile("mobile-android"),
      this.probeMobile("mobile-ios"),
    ]);
    const report = formatDiscoveryReport(substrates);
    return {
      protocol: "nexus-substrates/1",
      available: substrates.filter((s) => s.available).map((s) => s.kind),
      substrates,
      report,
    };
  }

  private status(kind: SubstrateKind, available: boolean, extra: Partial<SubstrateProviderStatus> = {}): SubstrateProviderStatus {
    return {
      kind,
      family: kindFamily(kind),
      label: kindLabel(kind),
      available,
      capabilities: FAMILY_CAPABILITIES[kindFamily(kind)],
      ...extra,
    };
  }

  private async probeWebBidi(): Promise<SubstrateProviderStatus> {
    const bidi = this.deps.bidi;
    if (!bidi) {
      return this.status("web-bidi", false, {
        reason: "no BiDi session attached — start geckodriver (default http://127.0.0.1:4444) and serve without --no-bidi",
      });
    }
    let title = "";
    let url = "";
    try {
      title = await withTimeout(this.probeMs, "BiDi title probe", () => bidi.page.title);
      url = await withTimeout(this.probeMs, "BiDi url probe", () => bidi.page.url);
    } catch {
      // The session is attached but the tab is not answering (page hung,
      // context closed). Still report attached — the surface exists.
    }
    return this.status("web-bidi", true, {
      detail: `attached session ${bidi.session.sessionId}`,
      targets: [{ id: bidi.page.context, label: title || "(untitled tab)", route: url }],
    });
  }


  private async probeWebCdp(): Promise<SubstrateProviderStatus> {
    const client = this.deps.chrome;
    if (!client) {
      // Lightweight unattached probe: is a CDP debug endpoint listening?
      const probeClient = new ChromeCdpClientCtor();
      const reachable = await withTimeout(1500, "CDP reachability probe", () => probeClient.isReachable());
      return this.status("web-cdp", reachable, reachable
        ? { detail: `CDP endpoint reachable on ${probeClient.baseHttp} (not attached — serve with --chrome)` }
        : { reason: `no CDP debug endpoint on ${probeClient.baseHttp} — launch Chrome with --remote-debugging-port=${probeClient.port} and serve with --chrome` });
    }
    try {
      const pages = await withTimeout(this.probeMs, "CDP tab probe", () => client.listPages());
      return this.status("web-cdp", true, {
        detail: `${pages.length} open tab(s) on ${client.baseHttp}`,
        targets: pages.map((p) => ({ id: p.id, label: p.title, route: p.url })),
      });
    } catch (e) {
      return this.status("web-cdp", false, { reason: `CDP endpoint failed: ${(e as Error).message}` });
    }
  }

  private async probeDesktop(kind: "desktop-windows" | "desktop-macos"): Promise<SubstrateProviderStatus> {
    const attached = this.deps.desktop;
    if (attached && attached.kind === kind) {
      try {
        const windows = await withTimeout(this.probeMs, `${kind} window probe`, () => attached.daemon.listWindows());
        return this.status(kind, true, {
          detail: `${windows.length} window(s)`,
          targets: windows.map((w) => ({ id: w.windowId, label: w.title, route: `desktop://${kind}/${w.processName}` })),
        });
      } catch (e) {
        return this.status(kind, false, { reason: `${kindLabel(kind)} probe failed: ${(e as Error).message}` });
      }
    }
    // Unattached: honest platform + operator state.
    if (kind === "desktop-windows" && process.platform !== "win32") {
      return this.status("desktop-windows", false, { reason: `unavailable on this host (${process.platform}); Windows UIA requires a win32 host` });
    }
    if (kind === "desktop-macos" && process.platform !== "darwin") {
      return this.status("desktop-macos", false, { reason: `unavailable on this host (${process.platform}); macOS AX requires a darwin host` });
    }
    // Platform matches but the operator did not attach this substrate.
    const slug = kind === "desktop-windows" ? "windows" : "macos";
    return this.status(kind, false, {
      reason: attached && attached.kind !== kind
        ? `not attached — serve with --desktop=${slug} (currently attached: ${attached.kind})`
        : `not attached — serve with --desktop=${slug}`,
    });
  }

  private async probeMobile(kind: "mobile-android" | "mobile-ios"): Promise<SubstrateProviderStatus> {
    const attached = this.deps.mobile;
    if (attached && attached.kind === kind) {
      const client = attached.client;
      try {
        if (client.listDevices) {
          const devices = await withTimeout(this.probeMs, `${kind} device probe`, () => client.listDevices!());
          const st = this.status(kind, devices.length > 0, {
            detail: devices.length > 0 ? `${devices.length} device(s)` : undefined,
            targets: devices.map((d) => ({ id: d.id, label: d.model ?? d.id, route: kind === "mobile-android" ? `android://${d.id}` : `ios://${d.id}` })),
          });
          if (devices.length === 0) st.reason = "driver reachable but no device attached";
          return st;
        }
        return this.status(kind, true, { detail: `attached ${kindLabel(kind)} client` });
      } catch (e) {
        return this.status(kind, false, { reason: `${kindLabel(kind)} probe failed: ${(e as Error).message}` });
      }
    }
    // Unattached: lightweight host probe so agents see real availability.
    if (kind === "mobile-android") {
      try {
        const probe = new AndroidClient();
        const devices = await withTimeout(this.probeMs, "adb devices probe", () => probe.listDevices());
        if (devices.length === 0) {
          return this.status("mobile-android", false, { reason: "adb reachable but no devices attached" });
        }
        return this.status("mobile-android", true, {
          detail: `${devices.length} adb device(s) reachable`,
          targets: devices.map((d) => ({ id: d.id, label: d.model ?? d.id, route: `android://${d.id}` })),
          reason: "reachable but not attached — serve with --mobile=android",
        });
      } catch (e) {
        return this.status("mobile-android", false, { reason: `adb not available: ${(e as Error).message}` });
      }
    }
    // iOS: probe the default WDA endpoint.
    try {
      const res = await withTimeout(1600, "WDA status probe", async () => {
        const r = await fetchWithTimeout("http://127.0.0.1:8100/status", 1500);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { ready?: boolean };
      });
      const ready = !!res?.ready;
      return this.status("mobile-ios", ready, {
        detail: ready ? "WDA ready on 127.0.0.1:8100" : undefined,
        reason: ready ? "reachable but not attached — serve with --mobile=ios" : "WebDriverAgent answered but is not ready",
      });
    } catch {
      return this.status("mobile-ios", false, { reason: "WebDriverAgent not reachable at http://127.0.0.1:8100" });
    }
  }

}

/** fetch with a timeout — used by the CDP and WDA reachability probes. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render the discovery report in the documented `nexus-substrates/1` text
 * format — the human-readable half of the discovery protocol. Deterministic:
 * substrates appear in fixed probe order, one block per substrate, so the
 * output is diff-stable and snapshot-able.
 *
 *   nexus-substrates/1
 *   web-bidi  AVAILABLE  Firefox (WebDriver BiDi)
 *     attached session 9c6f…
 *     target <context-id>  Sign up — demo  http://127.0.0.1:7311/
 *     capabilities: discover, inspect, …
 */
export function formatDiscoveryReport(substrates: SubstrateProviderStatus[]): string {
  const lines: string[] = ["nexus-substrates/1"];
  for (const s of substrates) {
    lines.push("");
    lines.push(`${s.kind}  ${s.available ? "AVAILABLE" : "OFF"}  ${s.label}`);
    const note = s.detail ?? s.reason;
    if (note) lines.push(`  ${note}`);
    if (s.targets && s.targets.length > 0) {
      for (const t of s.targets) lines.push(`  target ${t.id}  ${t.label}  ${t.route}`);
    }
    lines.push(`  capabilities: ${s.capabilities.join(", ")}`);
  }
  return lines.join("\n");
}

export type UniversalAction =
  | { type: "click" | "tap"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "swipe"; x: number; y: number; x2: number; y2: number; durationMs?: number }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "hotkey"; combo: string };

/** Navigation intent: web → URL, mobile → app, desktop → activate window/app. */
export interface NavigateIntent {
  url?: string;
  appId?: string;
  windowId?: string;
  processName?: string;
}

/** A server-owned BiDi session (the same structural shape as `BidiContext`). */
export interface BidiSessionHandle {
  session: BiDiSession;
  page: Page;
}

