/**
 * macOS AX Desktop Daemon — NexusOS (Phase D3).
 * Provides native Accessibility API (AXUIElement) integration for macOS environments.
 */
import { spawn } from "node:child_process";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DesktopDriverClient, DesktopSubstrateSurface } from "../../substrate/desktop-surface.js";
import { DesktopSubstrateSurface as DesktopSurfaceImpl } from "../../substrate/desktop-surface.js";
import type { RawMacOSAXNode } from "../../substrate/desktop-normalizer.js";
import type { Source } from "../../bidi-client/input.js";

export interface MacOSWindowInfo {
  windowId: string;
  title: string;
  processName: string;
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface MacOSAxDaemonOptions {
  timeoutMs?: number;
  defaultMaxDepth?: number;
  commandRunner?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export class MacOSAxDaemon implements DesktopDriverClient {
  public readonly platform = "macos" as const;
  private activeWindow?: MacOSWindowInfo;
  private readonly timeoutMs: number;
  private readonly defaultMaxDepth: number;
  private readonly customRunner?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

  constructor(opts: MacOSAxDaemonOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.defaultMaxDepth = opts.defaultMaxDepth ?? 5;
    this.customRunner = opts.commandRunner;
  }

  public async exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    if (this.customRunner) {
      return this.customRunner(cmd, args);
    }
    return new Promise((res, rej) => {
      const child = spawn(cmd, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        child.kill();
        rej(new Error(`Command timed out after ${this.timeoutMs}ms: ${cmd} ${args.join(" ")}`));
      }, this.timeoutMs);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        res({ stdout, stderr, code: code ?? 0 });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        rej(err);
      });
    });
  }

  public async runScript(code: string, language: "JavaScript" | "AppleScript" = "JavaScript"): Promise<string> {
    const isDarwin = process.platform === "darwin";
    if (!isDarwin && !this.customRunner) {
      throw new Error("macOS AX Daemon requires macOS (darwin) or a mocked command runner");
    }
    const args = language === "JavaScript" ? ["-l", "JavaScript", "-e", code] : ["-e", code];
    const { stdout, stderr, code: exitCode } = await this.exec("osascript", args);
    if (exitCode !== 0) {
      throw new Error(`osascript failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
    }
    return stdout.trim();
  }

  public async listWindows(): Promise<MacOSWindowInfo[]> {
    const script = `
      (() => {
        const se = Application("System Events");
        const procs = se.processes.where({ backgroundOnly: false })();
        const windows = [];
        for (const p of procs) {
          try {
            const pName = p.name();
            const pId = p.unixId();
            const wins = p.windows();
            for (let i = 0; i < wins.length; i++) {
              const w = wins[i];
              try {
                const title = w.name() || "Untitled";
                const pos = w.position();
                const size = w.size();
                windows.push({
                  windowId: pName + ":" + i,
                  title: title,
                  processName: pName,
                  processId: pId,
                  bounds: { x: pos[0], y: pos[1], width: size[0], height: size[1] }
                });
              } catch (err) {}
            }
          } catch (err) {}
        }
        return JSON.stringify(windows);
      })()
    `;

    try {
      const output = await this.runScript(script, "JavaScript");
      const list = JSON.parse(output);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  public async findWindow(pattern: string): Promise<MacOSWindowInfo | undefined> {
    const windows = await this.listWindows();
    const lower = pattern.toLowerCase();
    return windows.find(
      (w) => w.title.toLowerCase().includes(lower) || w.processName.toLowerCase().includes(lower)
    );
  }

  public async setActiveWindow(window: MacOSWindowInfo): Promise<void> {
    this.activeWindow = window;
    try {
      const script = `tell application "${window.processName}" to activate`;
      await this.runScript(script, "AppleScript");
    } catch {}
  }

  public async getActiveWindow(): Promise<MacOSWindowInfo> {
    if (this.activeWindow) return this.activeWindow;

    const script = `
      (() => {
        const se = Application("System Events");
        const frontProcs = se.processes.where({ frontmost: true })();
        if (frontProcs.length === 0) return null;
        const p = frontProcs[0];
        const pName = p.name();
        const pId = p.unixId();
        const wins = p.windows();
        if (wins.length === 0) {
          return JSON.stringify({
            windowId: pName + ":0",
            title: pName,
            processName: pName,
            processId: pId,
            bounds: { x: 0, y: 0, width: 1440, height: 900 }
          });
        }
        const w = wins[0];
        const pos = w.position();
        const size = w.size();
        return JSON.stringify({
          windowId: pName + ":0",
          title: w.name() || pName,
          processName: pName,
          processId: pId,
          bounds: { x: pos[0], y: pos[1], width: size[0], height: size[1] }
        });
      })()
    `;

    try {
      const output = await this.runScript(script, "JavaScript");
      if (output) {
        const win = JSON.parse(output) as MacOSWindowInfo;
        if (!win.bounds) {
          win.bounds = { x: 0, y: 0, width: 1440, height: 900 };
        }
        this.activeWindow = win;
        return win;
      }
    } catch {}

    const fallback: MacOSWindowInfo = {
      windowId: "1",
      title: "Active Window",
      processName: "Finder",
      processId: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    };
    this.activeWindow = fallback;
    return fallback;
  }

  public async getAccessibilityTree(maxDepth?: number): Promise<RawMacOSAXNode> {
    const depth = maxDepth ?? this.defaultMaxDepth;
    const script = `
      (() => {
        const se = Application("System Events");
        const frontProcs = se.processes.where({ frontmost: true })();
        if (frontProcs.length === 0) {
          return JSON.stringify({ role: "AXApplication", title: "Desktop Root", enabled: true, children: [] });
        }
        const proc = frontProcs[0];

        function walk(elem, currentDepth) {
          if (currentDepth > ${depth}) return null;
          let role = "AXUnknown";
          let title = "";
          let desc = "";
          let enabled = true;
          let focused = false;
          let value = null;

          try { role = elem.role() || "AXUnknown"; } catch(e) {}
          try { title = elem.title() || elem.name() || ""; } catch(e) {}
          try { desc = elem.description() || ""; } catch(e) {}
          try { enabled = elem.enabled(); } catch(e) {}
          try { focused = elem.focused(); } catch(e) {}
          try { value = elem.value(); } catch(e) {}

          const node = {
            role: role,
            title: title,
            description: desc,
            enabled: enabled,
            focused: focused,
            value: value,
            children: []
          };

          try {
            const uiElems = elem.uiElements();
            for (let i = 0; i < Math.min(uiElems.length, 50); i++) {
              const childNode = walk(uiElems[i], currentDepth + 1);
              if (childNode) node.children.push(childNode);
            }
          } catch(e) {}

          return node;
        }

        const root = walk(proc, 0);
        return JSON.stringify(root || { role: "AXApplication", title: proc.name(), enabled: true, children: [] });
      })()
    `;

    try {
      const output = await this.runScript(script, "JavaScript");
      return JSON.parse(output) as RawMacOSAXNode;
    } catch {
      return {
        role: "AXApplication",
        title: this.activeWindow?.title ?? "Desktop Root",
        enabled: true,
        children: [],
      };
    }
  }

  public async takeScreenshot(): Promise<string> {
    const isDarwin = process.platform === "darwin";
    if (!isDarwin && !this.customRunner) {
      return "";
    }
    const tempFile = join(tmpdir(), `awg_shot_${randomUUID()}.png`);
    try {
      await this.exec("screencapture", ["-x", "-C", "-t", "png", tempFile]);
      if (existsSync(tempFile)) {
        const buf = readFileSync(tempFile);
        unlinkSync(tempFile);
        return buf.toString("base64");
      }
      return "";
    } catch {
      if (existsSync(tempFile)) {
        try { unlinkSync(tempFile); } catch {}
      }
      return "";
    }
  }

  public async performInputActions(actions: Source[]): Promise<void> {
    for (const act of actions) {
      for (const sub of ((act as any).actions ?? [])) {
        if (sub.type === "pointerDown" || sub.type === "click") {
          const x = sub.x ?? 0;
          const y = sub.y ?? 0;
          const clickScript = `
            tell application "System Events"
              click at {${Math.round(x)}, ${Math.round(y)}}
            end tell
          `;
          try { await this.runScript(clickScript, "AppleScript"); } catch {}
        } else if (sub.type === "keyDown" && sub.value) {
          const val = String(sub.value).replace(/"/g, '\\"');
          const typeScript = `
            tell application "System Events"
              keystroke "${val}"
            end tell
          `;
          try { await this.runScript(typeScript, "AppleScript"); } catch {}
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

  public async dispatchKineticAction(_action: any): Promise<void> {}

  public async createSurface(_target?: any): Promise<DesktopSubstrateSurface> {
    return new DesktopSurfaceImpl("desktop-macos", "macos-window", this);
  }
}
