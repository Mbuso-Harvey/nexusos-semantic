/**
 * Android ADB & UIAutomator2 Client — NexusOS (Phase M1/M2).
 *
 * Interacts directly with Android devices via adb or UIAutomator2 daemon,
 * producing RawAndroidNode trees and executing kinetic touch dispatches.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MobileDriverClient } from "../../substrate/mobile-surface.js";
import type { RawAndroidNode } from "../../substrate/mobile-normalizer.js";
import type { Source } from "../../bidi-client/input.js";

const execFileAsync = promisify(execFile);

export interface AndroidDeviceInfo {
  id: string;
  state: string;
  model?: string;
  device?: string;
}

export interface AndroidClientOptions {
  deviceId?: string;
  adbPath?: string;
  uia2Port?: number;
}

export class AndroidClient implements MobileDriverClient {
  private deviceId?: string;
  private adbPath: string;
  private uia2Port?: number;

  constructor(opts: AndroidClientOptions = {}) {
    this.deviceId = opts.deviceId;
    this.adbPath = opts.adbPath ?? "adb";
    this.uia2Port = opts.uia2Port;
  }

  /**
   * Run an ADB command with arguments, auto-targeting device if set.
   */
  public async runAdb(args: string[], binary: boolean = false): Promise<{ stdout: string | Buffer; stderr: string }> {
    const fullArgs: string[] = [];
    if (this.deviceId) {
      fullArgs.push("-s", this.deviceId);
    }
    fullArgs.push(...args);

    try {
      const { stdout, stderr } = await execFileAsync(this.adbPath, fullArgs, {
        encoding: binary ? "buffer" : "utf8",
        maxBuffer: 50 * 1024 * 1024,
      });
      return { stdout, stderr: stderr ? stderr.toString() : "" };
    } catch (err: any) {
      throw new Error(`ADB command failed (adb ${fullArgs.join(" ")}): ${err.message}`);
    }
  }

  /**
   * List connected Android devices/emulators via `adb devices -l`.
   */
  public async listDevices(): Promise<AndroidDeviceInfo[]> {
    const { stdout } = await this.runAdb(["devices", "-l"]);
    const lines = (stdout as string).split(/\r?\n/);
    const devices: AndroidDeviceInfo[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("List of devices")) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const id = parts[0];
        const state = parts[1];
        let model: string | undefined;
        let device: string | undefined;

        for (const p of parts.slice(2)) {
          if (p.startsWith("model:")) model = p.replace("model:", "");
          if (p.startsWith("device:")) device = p.replace("device:", "");
        }
        devices.push({ id, state, model, device });
      }
    }
    return devices;
  }

  /**
   * Set target device ID for subsequent operations.
   */
  public setDevice(deviceId: string): void {
    this.deviceId = deviceId;
  }

  /**
   * Parse XML dump from `uiautomator dump` into canonical RawAndroidNode.
   * Uses an exact stack-based tokenizer to handle arbitrary depth and nested sibling nodes without regex truncation.
   */
  public parseXmlHierarchy(xml: string): RawAndroidNode | null {
    function parseAttributes(attrStr: string): Record<string, string> {
      const attrs: Record<string, string> = {};
      const re = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(attrStr)) !== null) {
        if (m[1] && m[2] !== undefined) {
          attrs[m[1]] = m[2];
        }
      }
      return attrs;
    }

    function parseBounds(boundsStr?: string): { left: number; top: number; right: number; bottom: number } | undefined {
      if (!boundsStr) return undefined;
      const m = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return undefined;
      return {
        left: parseInt(m[1], 10),
        top: parseInt(m[2], 10),
        right: parseInt(m[3], 10),
        bottom: parseInt(m[4], 10),
      };
    }

    function buildNode(attrStr: string): RawAndroidNode {
      const attrs = parseAttributes(attrStr);
      return {
        className: attrs["class"] ?? attrs["className"] ?? "android.view.View",
        text: attrs["text"] || undefined,
        contentDescription: attrs["content-desc"] || undefined,
        resourceId: attrs["resource-id"] || undefined,
        clickable: attrs["clickable"] === "true",
        checkable: attrs["checkable"] === "true",
        checked: attrs["checked"] === "true",
        enabled: attrs["enabled"] !== "false",
        focused: attrs["focused"] === "true",
        scrollable: attrs["scrollable"] === "true",
        selected: attrs["selected"] === "true",
        bounds: parseBounds(attrs["bounds"]),
      };
    }

    const trimmed = xml.trim();
    if (!trimmed) return null;

    const stack: RawAndroidNode[] = [];
    let rootNode: RawAndroidNode | null = null;

    // Tokenize tags: opening `<node ...>`, self-closing `<node .../>`, and closing `</node>`
    const tagRegex = /<node\s+([^>]*?)(\/?)>|<\/node>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(trimmed)) !== null) {
      const fullTag = match[0];

      if (fullTag === "</node>") {
        if (stack.length > 0) {
          stack.pop();
        }
      } else {
        const attrStr = match[1] || "";
        const isSelfClosing = match[2] === "/" || fullTag.endsWith("/>");
        const currentNode = buildNode(attrStr);

        if (stack.length === 0) {
          if (!rootNode) rootNode = currentNode;
        } else {
          const parent = stack[stack.length - 1];
          if (parent) {
            if (!parent.children) parent.children = [];
            parent.children.push(currentNode);
          }
        }

        if (!isSelfClosing) {
          stack.push(currentNode);
        }
      }
    }

    return rootNode;
  }

  // --- MobileDriverClient Contract ---

  public async getPageSource(): Promise<RawAndroidNode> {
    const dumpPath = "/data/local/tmp/awg_dump.xml";
    await this.runAdb(["shell", "uiautomator", "dump", dumpPath]);
    const { stdout } = await this.runAdb(["shell", "cat", dumpPath]);
    const xml = stdout.toString();
    const parsed = this.parseXmlHierarchy(xml);

    return parsed ?? {
      className: "android.widget.FrameLayout",
      bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    };
  }

  public async takeScreenshot(): Promise<string> {
    const { stdout } = await this.runAdb(["exec-out", "screencap", "-p"], true);
    if (Buffer.isBuffer(stdout)) {
      return stdout.toString("base64");
    }
    return Buffer.from(stdout as string, "binary").toString("base64");
  }

  public async getWindowRect(): Promise<{ width: number; height: number }> {
    try {
      const { stdout } = await this.runAdb(["shell", "wm", "size"]);
      const match = (stdout as string).match(/Physical size:\s*(\d+)x(\d+)/);
      if (match && match[1] && match[2]) {
        return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
      }
    } catch {}
    return { width: 1080, height: 2400 };
  }

  public async getCurrentActivityOrRoute(): Promise<string> {
    try {
      const { stdout } = await this.runAdb(["shell", "dumpsys", "window", "displays"]);
      const match = (stdout as string).match(/mCurrentFocus=Window\{[^}]+\s+([^\s}]+)\}/);
      if (match && match[1]) return match[1];
    } catch {}
    return "android://current-activity";
  }

  public async performTouchActions(actions: Source[]): Promise<void> {
    for (const act of actions) {
      for (const sub of ((act as any).actions ?? [])) {
        if (sub.type === "pointerDown" || sub.type === "click") {
          await this.tap(sub.x ?? 0, sub.y ?? 0);
        } else if (sub.type === "keyDown" && sub.value) {
          await this.typeText(sub.value);
        }
      }
    }
  }

  public async tap(x: number, y: number): Promise<void> {
    await this.runAdb(["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
  }

  public async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    await this.runAdb([
      "shell",
      "input",
      "swipe",
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(durationMs),
    ]);
  }

  public async typeText(text: string): Promise<void> {
    const escaped = text.replace(/([\\$`"!\s])/g, "\\$1");
    await this.runAdb(["shell", "input", "text", escaped]);
  }

  public async keyevent(keyCode: number): Promise<void> {
    await this.runAdb(["shell", "input", "keyevent", String(keyCode)]);
  }

  public async closeSession(): Promise<void> {
    // No-op for adb
  }
}
