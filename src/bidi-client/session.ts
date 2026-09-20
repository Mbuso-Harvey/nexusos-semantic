/**
 * BiDi session — creates a WebDriver session via the classic HTTP endpoint,
 * then opens the BiDi WebSocket using the webSocketUrl returned in capabilities.
 *
 * This is the entry point for every page. The caller is responsible for
 * calling session.close() (or letting it be GC'd) to free the browser.
 */
import { BiDiTransport } from "./transport.js";
import { BrowsingContextApi } from "./browsing-context.js";
import { Page } from "./page.js";

export type BrowserKind = "firefox";

export interface SessionOptions {
  /** WebDriver HTTP base (default http://127.0.0.1:4444) */
  webDriverBase?: string;
  /** Origin to send on the BiDi WS handshake (must match geckodriver --allow-origins) */
  bidiOrigin?: string;
  /** Override capabilities (mostly for tests) */
  capabilities?: Record<string, any>;
  /** WebSocket implementation (default: ws). Tests may inject a fake. */
  WebSocketCtor?: any;
  /**
   * Path to a resident Firefox profile directory.
   * When specified, Firefox attaches to this persistent profile, retaining
   * real human logins, storage, and WebAuthn hardware registrations.
   */
  profileDir?: string;
  /** Additional command-line arguments passed to the browser binary. */
  browserArgs?: string[];
}

export class BiDiSession {
  /** Lazily-instantiated; the transport already exists. */
  private _bc?: BrowsingContextApi;

  constructor(
    public readonly sessionId: string,
    public readonly transport: BiDiTransport,
    public readonly webDriverBase: string,
    /** Real browser version reported by WebDriver (e.g. "156.0"). */
    public readonly browserVersion: string | null = null,
  ) {}

  /** Open a new top-level browsing context (tab) and return a Page wrapping it. */
  async newPage(): Promise<Page> {
    if (!this._bc) this._bc = new BrowsingContextApi(this.transport);
    const { context } = await this._bc.create("tab");
    return new Page(this, context);
  }

  /** Close the session — deletes via classic HTTP and closes the WS. */
  async close(): Promise<void> {
    this.transport.close();
    try {
      await fetch(`${this.webDriverBase}/session/${this.sessionId}`, { method: "DELETE" });
      for (let i = 0; i < 20; i++) {
        try {
          const r = await fetch(`${this.webDriverBase}/status`);
          if (r.ok) {
            const j = await r.json() as any;
            if (j?.value?.ready) break;
          }
        } catch {
          // best-effort polling
        }
        await new Promise((res) => setTimeout(res, 200));
      }
    } catch {
      // best-effort; the browser-side geckodriver also handles orphan sessions
    }
  }

  /** Static factory: creates a session, opens BiDi WS, returns ready-to-use client. */
  static async create(browser: BrowserKind = "firefox", opts: SessionOptions = {}): Promise<BiDiSession> {
    const webDriverBase = opts.webDriverBase ?? "http://127.0.0.1:4444";
    const bidiOrigin = opts.bidiOrigin ?? "http://127.0.0.1:9222";

    const caps: Record<string, any> = opts.capabilities
      ? { ...opts.capabilities }
      : { browserName: browser, webSocketUrl: true };

    if (browser === "firefox" && (opts.profileDir || opts.browserArgs?.length)) {
      caps["moz:firefoxOptions"] = { ...(caps["moz:firefoxOptions"] ?? {}) };
      const currentArgs: string[] = caps["moz:firefoxOptions"].args ?? [];
      if (opts.browserArgs?.length) {
        currentArgs.push(...opts.browserArgs);
      }
      if (opts.profileDir) {
        currentArgs.push("-profile", opts.profileDir);
      }
      caps["moz:firefoxOptions"].args = currentArgs;
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch(`${webDriverBase}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: bidiOrigin },
          body: JSON.stringify({ capabilities: { alwaysMatch: caps } }),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`session create failed: ${r.status} ${text.slice(0, 300)}`);
        }
        const j = await r.json() as any;
        const sid: string = j.value.sessionId;
        const wsUrl: string = j.value.capabilities.webSocketUrl;
        if (!wsUrl) throw new Error("session created but no webSocketUrl in capabilities");
        const browserVersion: string | null =
          typeof j.value?.capabilities?.browserVersion === "string" && j.value.capabilities.browserVersion
            ? j.value.capabilities.browserVersion
            : null;

        // Construct the transport with the configured origin. The transport
        // hard-codes a default origin for the simple case; tests inject
        // WebSocketCtor; here we open the WS directly so the Origin header is set.
        const transport = new BiDiTransport(wsUrl, { origin: bidiOrigin });
        await transport.open();
        return new BiDiSession(sid, transport, webDriverBase, browserVersion);
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message ?? err);
        if (attempt < 5 && (msg.includes("Session is already started") || msg.includes("ECONNRESET"))) {
          await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}
