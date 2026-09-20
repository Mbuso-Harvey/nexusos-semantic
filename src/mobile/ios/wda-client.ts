/**
 * iOS WebDriverAgent (WDA) Client — NexusOS (Phase M1/M2).
 *
 * Interacts directly with iOS devices or Simulators running WebDriverAgent
 * via HTTP API, producing RawIOSNode trees and dispatching touch/kinetic actions.
 */
import type { MobileDriverClient } from "../../substrate/mobile-surface.js";
import type { RawIOSNode } from "../../substrate/mobile-normalizer.js";
import type { Source } from "../../bidi-client/input.js";

export interface WdaClientOptions {
  host?: string;
  port?: number;
  sessionId?: string;
}

export class WdaClient implements MobileDriverClient {
  private baseUrl: string;
  private sessionId?: string;

  constructor(opts: WdaClientOptions = {}) {
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 8100;
    this.baseUrl = `http://${host}:${port}`;
    this.sessionId = opts.sessionId;
  }

  private async request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      throw new Error(`WDA request failed [${res.status}]: ${res.statusText} at ${path}`);
    }
    return (await res.json()) as T;
  }

  public async getStatus(): Promise<any> {
    return this.request("/status");
  }

  // --- MobileDriverClient Contract ---

  public async getPageSource(): Promise<RawIOSNode> {
    const data = await this.request<{ value: RawIOSNode | string }>("/source?format=json");
    if (typeof data.value === "string") {
      return JSON.parse(data.value);
    }
    return data.value;
  }

  public async takeScreenshot(): Promise<string> {
    const data = await this.request<{ value: string }>("/screenshot");
    return data.value;
  }

  public async getWindowRect(): Promise<{ width: number; height: number }> {
    try {
      const data = await this.request<{ value: { width: number; height: number } }>("/window/size");
      return data.value;
    } catch {
      return { width: 390, height: 844 }; // Default iPhone standard
    }
  }

  public async getCurrentActivityOrRoute(): Promise<string> {
    try {
      const status = await this.getStatus();
      return status?.value?.currentApp ?? "ios://active-app";
    } catch {
      return "ios://active-app";
    }
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
    await this.request("/wda/tap", {
      method: "POST",
      body: JSON.stringify({ x: Math.round(x), y: Math.round(y) }),
    });
  }

  public async typeText(text: string): Promise<void> {
    await this.request("/wda/keys", {
      method: "POST",
      body: JSON.stringify({ value: text.split("") }),
    });
  }

  public async createSession(bundleId?: string, capabilities?: Record<string, any>): Promise<string> {
    const payload: any = {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          ...(bundleId ? { "appium:bundleId": bundleId } : {}),
          ...(capabilities ?? {}),
        },
      },
    };
    const res = await this.request<{ sessionId: string }>("/session", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    this.sessionId = res.sessionId;
    return res.sessionId;
  }

  public async swipe(fromX: number, fromY: number, toX: number, toY: number, durationSec = 0.5): Promise<void> {
    await this.request("/wda/dragfromtoforduration", {
      method: "POST",
      body: JSON.stringify({
        fromX: Math.round(fromX),
        fromY: Math.round(fromY),
        toX: Math.round(toX),
        toY: Math.round(toY),
        duration: durationSec,
      }),
    });
  }

  public async longPress(x: number, y: number, durationSec = 1.0): Promise<void> {
    await this.request("/wda/touchAndHold", {
      method: "POST",
      body: JSON.stringify({
        x: Math.round(x),
        y: Math.round(y),
        duration: durationSec,
      }),
    });
  }

  public async pressHome(): Promise<void> {
    await this.request("/wda/homescreen", {
      method: "POST",
    });
  }

  public async getAlertText(): Promise<string | null> {
    try {
      const res = await this.request<{ value: string }>("/alert/text");
      return res.value ?? null;
    } catch {
      return null;
    }
  }

  public async acceptAlert(): Promise<void> {
    await this.request("/alert/accept", {
      method: "POST",
    });
  }

  public async dismissAlert(): Promise<void> {
    await this.request("/alert/dismiss", {
      method: "POST",
    });
  }

  public async launchApp(bundleId: string): Promise<void> {
    await this.request("/wda/apps/launch", {
      method: "POST",
      body: JSON.stringify({ bundleId }),
    });
  }

  public async activateApp(bundleId: string): Promise<void> {
    await this.request("/wda/apps/activate", {
      method: "POST",
      body: JSON.stringify({ bundleId }),
    });
  }

  public async terminateApp(bundleId: string): Promise<boolean> {
    const res = await this.request<{ value: boolean }>("/wda/apps/terminate", {
      method: "POST",
      body: JSON.stringify({ bundleId }),
    });
    return res.value ?? true;
  }

  public async closeSession(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.request(`/session/${this.sessionId}`, { method: "DELETE" });
      } catch {}
      this.sessionId = undefined;
    }
  }
}
