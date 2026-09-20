/**
 * Chrome DevTools Protocol (CDP) client — direct attachment to running Chrome.
 *
 * Per DESKTOP_SUBSTRATE_SPEC.md §2.3: "When launched with
 * `--remote-debugging-port=9222`, NexusOS connects directly via Chrome
 * DevTools Protocol / BiDi without needing an OS-level accessibility wrapper."
 *
 * This client closes the #1 substrate gap: reading the DOM of
 * ALREADY-AUTHENTICATED Chrome sessions (Anthropic console, Railway,
 * Cartesia, Twilio, Deepgram, etc.) without re-login. The desktop UIA
 * bridge can see tab titles but Chromium blocks it from page content —
 * CDP is the sanctioned path to that content.
 *
 * Capabilities:
 *   - Enumerate all open tabs/targets via HTTP /json/list
 *   - Attach to any tab via its webSocketDebuggerUrl
 *   - Runtime.evaluate: run JS in page context, read DOM, cookies, storage
 *   - DOM.querySelector / DOM.getDocument: structured DOM access
 *   - Page.captureScreenshot: per-tab screenshots
 *   - Network.getAllCookies / Network.getCookies: cookie extraction
 *   - Page.navigate: drive a tab to a URL
 *   - launchChromeWithDebug(): spawn a fresh Chrome with --remote-debugging-port
 *
 * Security boundary: owner-authorized, local-only, no exfiltration.
 * This reads the CURRENT USER's own browser sessions on their own machine.
 */

import WebSocket from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CdpTarget {
  id: string;
  type: "page" | "background_page" | "service_worker" | "browser" | "other";
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpVersionInfo {
  Browser: string;
  "Protocol-Version": string;
  "User-Agent"?: string;
  "V8-Version"?: string;
  webSocketDebuggerUrl?: string;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
}export interface DomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount: number;
  attributes?: string[];
}

export interface EvaluateResult {
  result: {
    type?: string;
    value?: unknown;
    description?: string;
    subtype?: string;
    className?: string;
    objectId?: string;
  } | null;
  exceptionDetails?: {
    text: string;
    lineNumber: number;
    columnNumber: number;
    exception?: { type: string; value: unknown; description?: string };
  } | null;
}

export interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: string;
}

export interface ChromeCdpOptions {
  port?: number;
  host?: string;
  commandTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// CdpSession — a live WebSocket connection to one target
// ---------------------------------------------------------------------------

type PendingCommand = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
};

export class CdpSession {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, PendingCommand>();
  private eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  private constructor(
    ws: WebSocket,
    private readonly timeoutMs: number,
  ) {
    this.ws = ws;
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", () => {
      this.closed = true;
      this.failAll(new Error("CDP session closed"));
    });
    this.ws.on("error", (e) => this.failAll(new Error(`CDP WS error: ${e.message}`)));
  }

  static connect(webSocketDebuggerUrl: string, timeoutMs: number): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      const onOpen = () => {
        cleanup();
        resolve(new CdpSession(ws, timeoutMs));
      };
      const onError = (e: Error) => {
        cleanup();
        reject(new Error(`CDP connect failed: ${e.message}`));
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result ?? null);
      }
    } else if (msg.method) {
      const listeners = this.eventListeners.get(msg.method);
      if (listeners) for (const fn of listeners) fn(msg.params);
    }
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

send<T = unknown>(method: string, params: Record<string, any> = {}): Promise<T> {
    if (this.closed) throw new Error(`CDP: cannot send ${method}; session closed`);
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${this.timeoutMs}ms: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, fn: (params: unknown) => void): () => void {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(fn);
    return () => this.eventListeners.get(event)?.delete(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* best-effort */
    }
  }

  /** Run JS in the page context and return the value. Throws on exception. */
  async evaluate<T = unknown>(
    expression: string,
    opts: { awaitPromise?: boolean; returnByValue?: boolean } = {},
  ): Promise<T> {
    const r = await this.send<EvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: opts.awaitPromise ?? true,
      returnByValue: opts.returnByValue ?? true,
    });
    if (r?.exceptionDetails) {
      const text = r.exceptionDetails.text ?? "unknown error";
      const exDesc = r.exceptionDetails.exception?.description ?? "";
      throw new Error(`CDP evaluate error: ${text}${exDesc ? ` - ${exDesc}` : ""}`.trim());
    }
    return r?.result?.value as T;
  }

  getPageHtml(): Promise<string> {
    return this.evaluate<string>("document.documentElement.outerHTML");
  }

  getPageText(): Promise<string> {
    return this.evaluate<string>("document.body ? document.body.innerText : ''");
  }

  getPageCookies(): Promise<string> {
    return this.evaluate<string>("document.cookie");
  }

  getLocalStorage(): Promise<Record<string, string>> {
    return this.evaluate<Record<string, string>>(
      "(() => { const o: Record<string,string> = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) o[k] = localStorage.getItem(k) ?? ''; } return o; })()",
    );
  }

  getSessionStorage(): Promise<Record<string, string>> {
    return this.evaluate<Record<string, string>>(
      "(() => { const o: Record<string,string> = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k) o[k] = sessionStorage.getItem(k) ?? ''; } return o; })()",
    );
  }

  getUrl(): Promise<string> {
    return this.evaluate<string>("window.location.href");
  }

  getTitle(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  /** Capture a full snapshot: title, url, visible text, storage, document cookies. */
  async snapshot(): Promise<PageSnapshot> {
    const [title, url, text, localStorage, sessionStorage, cookies] = await Promise.all([
      this.getTitle(),
      this.getUrl(),
      this.getPageText(),
      this.getLocalStorage(),
      this.getSessionStorage(),
      this.getPageCookies(),
    ]);
    return { title, url, text, localStorage, sessionStorage, cookies };
  }

  async getDocument(depth = -1): Promise<DomNode> {
    const r = await this.send<{ root: DomNode }>("DOM.getDocument", { depth, pierce: true });
    return r.root;
  }

  async querySelector(nodeId: number, selector: string): Promise<number> {
    const r = await this.send<{ nodeId: number }>("DOM.querySelector", { nodeId, selector });
    return r.nodeId;
  }

  async querySelectorHtml(nodeId: number, selector: string): Promise<string> {
    const targetId = await this.querySelector(nodeId, selector);
    const r = await this.send<{ outerHTML: string }>("DOM.getOuterHTML", { nodeId: targetId });
    return r.outerHTML;
  }

  async getAllCookies(): Promise<Cookie[]> {
    const r = await this.send<{ cookies: Cookie[] }>("Network.getAllCookies");
    return r.cookies;
  }

  async getCookiesForUrls(urls: string[]): Promise<Cookie[]> {
    const r = await this.send<{ cookies: Cookie[] }>("Network.getCookies", { urls });
    return r.cookies;
  }

  async screenshot(format: "png" | "jpeg" = "png", quality?: number): Promise<string> {
    const r = await this.send<{ data: string }>("Page.captureScreenshot", { format, quality });
    return r.data;
  }

  async activate(): Promise<void> {
    await this.send("Page.bringToFront");
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }
}// ---------------------------------------------------------------------------
// ChromeCdpClient — discovers targets via HTTP and attaches sessions
// ---------------------------------------------------------------------------

export class ChromeCdpClient {
  readonly port: number;
  readonly host: string;
  readonly baseHttp: string;
  private readonly commandTimeoutMs: number;

  constructor(opts: ChromeCdpOptions = {}) {
    this.port = opts.port ?? 9222;
    this.host = opts.host ?? "127.0.0.1";
    this.baseHttp = `http://${this.host}:${this.port}`;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 15_000;
  }

  async version(): Promise<CdpVersionInfo> {
    const r = await fetch(`${this.baseHttp}/json/version`);
    if (!r.ok) throw new Error(`CDP version: HTTP ${r.status}`);
    return (await r.json()) as CdpVersionInfo;
  }

  async listTargets(): Promise<CdpTarget[]> {
    const r = await fetch(`${this.baseHttp}/json/list`);
    if (!r.ok) {
      throw new Error(
        `CDP list: HTTP ${r.status} — is Chrome running with --remote-debugging-port=${this.port}?`,
      );
    }
    return (await r.json()) as CdpTarget[];
  }

  async listPages(): Promise<CdpTarget[]> {
    const all = await this.listTargets();
    return all.filter((t) => t.type === "page" || t.type === "background_page");
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.version();
      return true;
    } catch {
      return false;
    }
  }

  async withSession<T>(target: CdpTarget, job: (session: CdpSession) => Promise<T>): Promise<T> {
    const session = await this.attachSession(target);
    try {
      return await job(session);
    } finally {
      session.close();
    }
  }

  attachSession(target: CdpTarget): Promise<CdpSession> {
    return CdpSession.connect(target.webSocketDebuggerUrl, this.commandTimeoutMs);
  }
}// ---------------------------------------------------------------------------
// Chrome launcher — spawn Chrome with a remote-debugging port
// ---------------------------------------------------------------------------

export interface ChromeLaunchOptions {
  port?: number;
  userDataDir?: string;
  headless?: boolean;
  url?: string;
  executablePath?: string;
  additionalArgs?: string[];
  timeoutMs?: number;
}

export interface LaunchedChrome {
  pid: number;
  port: number;
  process: ChildProcess;
  stop: () => void;
}

const CHROME_CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter((p) => p.length > 0),
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

export function findChromeExecutable(): string | null {
  const candidates = CHROME_CANDIDATES[process.platform] ?? [];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Launch (or re-launch) Chrome with a remote-debugging port so that a
 * CDP client can attach and read page DOM/storage of authenticated sessions.
 *
 * Uses a DEDICATED user-data-dir when provided so the main browsing profile
 * is never disturbed. Waits until the /json/version endpoint answers.
 */
export async function launchChromeWithDebug(
  opts: ChromeLaunchOptions = {},
): Promise<LaunchedChrome> {
  const port = opts.port ?? 9222;
  const exe = opts.executablePath ?? findChromeExecutable();
  if (!exe) throw new Error("Chrome executable not found on this host");

  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (opts.userDataDir) args.push(`--user-data-dir=${opts.userDataDir}`);
  if (opts.headless) args.push("--headless=new");
  if (opts.url) args.push(opts.url);
  if (opts.additionalArgs) args.push(...opts.additionalArgs);

  const child = spawn(exe, args, { stdio: "ignore", detached: false });
  const client = new ChromeCdpClient({ port });
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;

  // Wait for the debug endpoint to come up (poll /json/version).
  for (;;) {
    if (await client.isReachable()) {
      return {
        pid: child.pid ?? 0,
        port,
        process: child,
        stop: () => {
          try {
            child.kill();
          } catch {
            /* best-effort */
          }
        },
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`Chrome did not expose CDP endpoint on port ${port} within ${timeoutMs}ms`);
}// ---------------------------------------------------------------------------
// One-shot convenience functions
// ---------------------------------------------------------------------------

export async function isChromeCdpReachable(port = 9222, host = "127.0.0.1"): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function readTabByUrl(
  urlPattern: string,
  port = 9222,
): Promise<{ title: string; url: string; text: string } | null> {
  const client = new ChromeCdpClient({ port });
  if (!(await client.isReachable())) return null;
  const pages = await client.listPages();
  const match = pages.find((p) => p.url.includes(urlPattern));
  if (!match) return null;
  return client.withSession(match, async (s) => ({
    title: await s.getTitle(),
    url: await s.getUrl(),
    text: await s.getPageText(),
  }));
}

export async function snapshotTabByUrl(
  urlPattern: string,
  port = 9222,
): Promise<PageSnapshot | null> {
  const client = new ChromeCdpClient({ port });
  if (!(await client.isReachable())) return null;
  const pages = await client.listPages();
  const match = pages.find((p) => p.url.includes(urlPattern));
  if (!match) return null;
  return client.withSession(match, async (s) => s.snapshot());
}

export async function extractChromeCookies(
  domainFilter?: string,
  port = 9222,
): Promise<Cookie[] | null> {
  const client = new ChromeCdpClient({ port });
  if (!(await client.isReachable())) return null;
  const pages = await client.listPages();
  const first = pages[0];
  if (!first) return [];
  return client.withSession(first, async (s) => {
    const all = await s.getAllCookies();
    if (!domainFilter) return all;
    return all.filter((c) => c.domain.includes(domainFilter));
  });
}