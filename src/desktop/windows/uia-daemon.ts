/**
 * Windows Direct UIA Daemon — NexusOS.
 * Provides native UI Automation tree extraction and kinetic dispatch on Windows OS.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DesktopDriverClient } from "../../substrate/desktop-surface.js";
import { DesktopSubstrateSurface } from "../../substrate/desktop-surface.js";
import type { RawWindowsUIANode } from "../../substrate/desktop-normalizer.js";
import type { Source } from "../../bidi-client/input.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let script = resolve(__dirname, "scripts", "uia-bridge.ps1");
if (!existsSync(script)) {
  const fallback = resolve(__dirname, "..", "..", "..", "src", "desktop", "windows", "scripts", "uia-bridge.ps1");
  if (existsSync(fallback)) {
    script = fallback;
  }
}
const BRIDGE_SCRIPT = script;

export interface DesktopWindowInfo {
  windowId: string;
  title: string;
  processName: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface WindowsUiaTarget {
  windowId?: string;
  titlePattern?: string;
}

export interface DesktopReadTextResult {
  status: "ok";
  windowId: string;
  method: "TextPattern" | "ValuePattern";
  text: string;
}

export interface DesktopReplaceTextResult {
  status: "ok";
  windowId: string;
  method: "ValuePattern" | "Clipboard";
  text: string;
}

export class WindowsUiaDaemon implements DesktopDriverClient {
  public readonly platform = "windows" as const;
  private readonly powershellPath: string;
  private readonly defaultMaxDepth: number;
  private readonly timeoutMs: number;
  private activeWindow?: DesktopWindowInfo;

  constructor(opts: { powershellPath?: string; defaultMaxDepth?: number; timeoutMs?: number } = {}) {
    this.powershellPath = opts.powershellPath ?? "powershell.exe";
    this.defaultMaxDepth = opts.defaultMaxDepth ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private async runBridge(args: string[]): Promise<any> {
    return new Promise((res, rej) => {
      const child = spawn(this.powershellPath, [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BRIDGE_SCRIPT, ...args,
      ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        const rejectTimeout = () => rej(new Error(`UIA bridge timed out after ${this.timeoutMs}ms`));
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          const fallback = setTimeout(() => {
            if (!child.killed) child.kill();
            rejectTimeout();
          }, 2_000);
          killer.on("close", (code) => {
            clearTimeout(fallback);
            if (code !== 0 && !child.killed) child.kill();
            rejectTimeout();
          });
          killer.on("error", () => {
            clearTimeout(fallback);
            if (!child.killed) child.kill();
            rejectTimeout();
          });
        } else {
          child.kill();
          rejectTimeout();
        }
      }, this.timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0 && !stdout.trim()) {
          return rej(new Error(`UIA Bridge error (${code}): ${stderr.trim()}`));
        }
        try { res(JSON.parse(stdout.trim())); } catch (e: any) {
          rej(new Error(`Failed to parse UIA output: ${e.message}`));
        }
      });
      child.on("error", (err) => { clearTimeout(timer); rej(err); });
    });
  }

  public async listWindows(): Promise<DesktopWindowInfo[]> {
    const raw = await this.runBridge(["-Action", "ListWindows"]);
    return Array.isArray(raw) ? raw : [raw];
  }

  public async findWindow(pattern: string): Promise<DesktopWindowInfo | undefined> {
    const windows = await this.listWindows();
    const lower = pattern.toLowerCase();
    return windows.find((w) => w.title.toLowerCase().includes(lower) || w.processName.toLowerCase().includes(lower));
  }

  public async setActiveWindow(window: DesktopWindowInfo): Promise<void> {
    this.activeWindow = window;
  }

  public async getActiveWindow(): Promise<DesktopWindowInfo> {
    if (this.activeWindow) return this.activeWindow;
    const windows = await this.listWindows();
    const first = windows[0];
    if (!first) throw new Error("No desktop windows found");
    this.activeWindow = first;
    return this.activeWindow;
  }

  public async getWindowHierarchy(windowId?: string, maxDepth?: number): Promise<RawWindowsUIANode> {
    const depth = maxDepth ?? this.defaultMaxDepth;
    const args = ["-Action", "DumpTree", "-MaxDepth", String(depth)];
    const targetId = windowId ?? this.activeWindow?.windowId;
    if (targetId) args.push("-WindowHandle", targetId);
    return (await this.runBridge(args)) as RawWindowsUIANode;
  }

  // --- DesktopDriverClient Contract ---
  public async getAccessibilityTree(): Promise<RawWindowsUIANode> {
    return this.getWindowHierarchy(this.activeWindow?.windowId, this.defaultMaxDepth);
  }

  public async takeScreenshot(): Promise<string> {
    const args = ["-Action", "Screenshot"];
    if (this.activeWindow?.windowId) args.push("-WindowHandle", this.activeWindow.windowId);
    const res = await this.runBridge(args);
    return res?.base64 ?? "";
  }

  public async performInputActions(actions: Source[]): Promise<void> {
    for (const act of actions) {
      for (const sub of ((act as any).actions ?? [])) {
        if (sub.type === "pointerDown" || sub.type === "click") {
          await this.dispatchKineticAction({ type: "click", x: sub.x, y: sub.y });
        } else if (sub.type === "keyDown" && sub.value) {
          await this.dispatchKineticAction({ type: "type", text: sub.value });
        }
      }
    }
  }

  public async getActiveWindowBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
    return (await this.getActiveWindow()).bounds;
  }

  public async getActiveWindowTitle(): Promise<string> {
    return (await this.getActiveWindow()).title;
  }

  public async getActiveProcessName(): Promise<string> {
    return (await this.getActiveWindow()).processName;
  }

  public async closeSession(): Promise<void> {
    this.activeWindow = undefined;
  }

  public async focusWindow(windowId?: string): Promise<void> {
    const targetId = windowId ?? this.activeWindow?.windowId;
    if (!targetId) throw new Error("No target window specified to focus");
    await this.runBridge(["-Action", "Focus", "-WindowHandle", targetId]);
  }

  public async setWindowState(windowId: string | undefined, state: "Minimize" | "Maximize" | "Restore"): Promise<void> {
    const targetId = windowId ?? this.activeWindow?.windowId;
    if (!targetId) throw new Error("No target window specified for window state");
    await this.runBridge(["-Action", "WindowState", "-WindowHandle", targetId, "-WindowState", state]);
  }

  public async sendHotkey(hotkey: string): Promise<void> {
    await this.runBridge(["-Action", "SendHotkey", "-Text", hotkey]);
  }

  private async refreshTarget(target: WindowsUiaTarget = {}): Promise<DesktopWindowInfo> {
    const windows = await this.listWindows();
    let window: DesktopWindowInfo | undefined;
    if (target.windowId) {
      window = windows.find((candidate) => candidate.windowId === target.windowId);
      if (!window) throw new Error(`Could not find window with id '${target.windowId}'`);
    } else if (target.titlePattern) {
      const lower = target.titlePattern.toLowerCase();
      window = windows.find((candidate) =>
        candidate.title.toLowerCase().includes(lower) || candidate.processName.toLowerCase().includes(lower));
      if (!window) throw new Error(`Could not find window matching '${target.titlePattern}'`);
    } else {
      window = this.activeWindow
        ? windows.find((candidate) => candidate.windowId === this.activeWindow?.windowId)
        : windows[0];
      if (!window) throw new Error("No desktop windows found");
    }
    this.activeWindow = window;
    return window;
  }

  public async readText(target: WindowsUiaTarget = {}): Promise<DesktopReadTextResult> {
    const window = await this.refreshTarget(target);
    return await this.runBridge([
      "-Action", "ReadText", "-WindowHandle", window.windowId,
    ]) as DesktopReadTextResult;
  }

  public async replaceText(
    text: string,
    expectedCurrentText: string,
    target: WindowsUiaTarget,
  ): Promise<DesktopReplaceTextResult> {
    if (!target.windowId) throw new Error("replaceText requires an explicit windowId");
    if (text.length > 12_000 || expectedCurrentText.length > 12_000) {
      throw new Error("desktop text payload exceeds the safe 12,000-character command-line limit");
    }
    const window = await this.refreshTarget(target);
    return await this.runBridge([
      "-Action", "ReplaceText", "-WindowHandle", window.windowId,
      "-ExpectedText", expectedCurrentText, "-Text", text,
    ]) as DesktopReplaceTextResult;
  }

  public async dispatchKineticAction(action: any): Promise<void> {
    if (action.type === "click" || action.type === "pointer") {
      const x = Math.round(action.x ?? action.target?.x ?? 0);
      const y = Math.round(action.y ?? action.target?.y ?? 0);
      await this.runBridge(["-Action", "Click", "-X", String(x), "-Y", String(y)]);
    } else if (action.type === "rightClick") {
      const x = Math.round(action.x ?? action.target?.x ?? 0);
      const y = Math.round(action.y ?? action.target?.y ?? 0);
      await this.runBridge(["-Action", "RightClick", "-X", String(x), "-Y", String(y)]);
    } else if (action.type === "type" || action.type === "key") {
      const text = action.text ?? action.key ?? "";
      await this.runBridge(["-Action", "SendText", "-Text", text]);
    } else if (action.type === "hotkey" || action.type === "shortcut") {
      const text = action.text ?? action.keys ?? action.hotkey ?? "";
      await this.sendHotkey(text);
    } else if (action.type === "focus") {
      await this.focusWindow(action.windowId);
    } else if (action.type === "windowState") {
      await this.setWindowState(action.windowId, action.state);
    }
  }

  public async createSurface(target?: { titlePattern?: string; windowId?: string } | string): Promise<DesktopSubstrateSurface> {
    let windowId: string | undefined;
    if (typeof target === "string") {
      const win = await this.findWindow(target);
      if (!win) throw new Error(`Could not find window matching '${target}'`);
      this.activeWindow = win;
      windowId = win.windowId;
    } else if (target?.titlePattern) {
      const win = await this.findWindow(target.titlePattern);
      if (!win) throw new Error(`Could not find window matching '${target.titlePattern}'`);
      this.activeWindow = win;
      windowId = win.windowId;
    } else if (target?.windowId) {
      windowId = target.windowId;
      const windows = await this.listWindows();
      const win = windows.find((w) => w.windowId === windowId);
      if (win) this.activeWindow = win;
    }

    const surfaceId = windowId ?? (this.activeWindow ? this.activeWindow.windowId : "active");
    return new DesktopSubstrateSurface("desktop-windows", surfaceId, this);
  }
}
