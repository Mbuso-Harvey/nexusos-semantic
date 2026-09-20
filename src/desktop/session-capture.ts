/**
 * Chrome Session Capture — bridges Chrome CDP to the crawler's auth-state format.
 *
 * Closes the last integration gap: converts a live, authenticated Chrome
 * session (cookies + localStorage + sessionStorage per origin) into the
 * SessionStorageState JSON that `awg crawl --auth-file` consumes.
 *
 * Workflow:
 *   1. `awg session-capture --launch` -> spawns a debug Chrome with an
 *      isolated profile so the owner's daily profile is never touched.
 *   2. User logs into their vendor dashboards in that Chrome window.
 *   3. On --capture (or after --wait-seconds), Nexus reads cookies + storage
 *      via CDP and writes auth-state.json.
 *   4. `awg crawl --auth-file auth-state.json` replides that authenticated
 *      state into the headless BiDi crawler.
 *
 * Security boundary: owner-authorized, local-only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { Cookie, ChromeCdpClient, launchChromeWithDebug, type LaunchedChrome } from "./chrome-cdp.js";
import type { SessionStorageState, SessionCookieState, StorageOriginState, StorageEntry } from "../crawler/session-auth.js";

export interface CaptureOptions {
  port?: number;
  host?: string;
  urlPatterns?: string[];
  cookieDomainFilter?: string;
  commandTimeoutMs?: number;
}

export interface LaunchCaptureOptions extends CaptureOptions {
  launch?: boolean;
  userDataDir?: string;
  waitSeconds?: number;
  openUrl?: string;
  headless?: boolean;
}

export async function captureSessionFromCdp(opts: CaptureOptions = {}): Promise<SessionStorageState> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "127.0.0.1";
  const client = new ChromeCdpClient({ port, host, commandTimeoutMs: opts.commandTimeoutMs });
  if (!(await client.isReachable())) {
    throw new Error(`Chrome CDP not reachable on ${host}:${port}. Launch Chrome with --remote-debugging-port=${port} or use --launch.`);
  }
  const allPages = await client.listPages();
  if (allPages.length === 0) throw new Error("No page targets found in Chrome. Open at least one tab.");
  const httpPages = allPages.filter((p) => {
    if (!/^https?:$/.test(new URL(p.url).protocol)) return false;
    if (!opts.urlPatterns || opts.urlPatterns.length === 0) return true;
    return opts.urlPatterns.some((pat) => p.url.includes(pat));
  });
  const targets = httpPages.length > 0 ? httpPages : allPages;

  const first = targets[0]!;
  let cookies: Cookie[] = [];
  try { cookies = await client.withSession(first, (s) => s.getAllCookies()); } catch { /* best-effort */ }
  if (opts.cookieDomainFilter) cookies = cookies.filter((c) => c.domain.includes(String(opts.cookieDomainFilter)));

  const cookieState: SessionCookieState[] = cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires,
    httpOnly: c.httpOnly, secure: c.secure,
    sameSite: (c.sameSite?.toLowerCase() as "strict" | "lax" | "none" | null) ?? null,
  }));

  const originMap = new Map<string, StorageOriginState>();
  for (const target of targets) {
    let origin: string;
    try { origin = new URL(target.url).origin; } catch { continue; }
    if (originMap.has(origin)) continue;
    let ls: StorageEntry[] = [];
    let ss: StorageEntry[] = [];
    try {
      ls = await client.withSession(target, async (s) => {
        const raw = await s.evaluate<Record<string, string>>("(() => { const o={}; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(k) o[k]=localStorage.getItem(k)??'';} return o; })()");
        return Object.entries(raw).map(([name, value]) => ({ name, value }));
      });
    } catch { /* best-effort */ }
    try {
      ss = await client.withSession(target, async (s) => {
        const raw = await s.evaluate<Record<string, string>>("(() => { const o={}; for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i); if(k) o[k]=sessionStorage.getItem(k)??'';} return o; })()");
        return Object.entries(raw).map(([name, value]) => ({ name, value }));
      });
    } catch { /* best-effort */ }
    if (ls.length > 0 || ss.length > 0) {
      const entry: StorageOriginState = { origin, localStorage: ls };
      if (ss.length > 0) (entry as StorageOriginState & { sessionStorage: StorageEntry[] }).sessionStorage = ss;
      originMap.set(origin, entry);
    }
  }

  return {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    cookies: cookieState,
    origins: originMap.size > 0 ? [...originMap.values()] : undefined,
  };
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once("line", () => { rl.close(); resolve(); });
  });
}

export async function launchAndCaptureSession(opts: LaunchCaptureOptions): Promise<{ state: SessionStorageState; launched: LaunchedChrome | null }> {
  let launched: LaunchedChrome | null = null;
  if (opts.launch) {
    const userDataDir = opts.userDataDir ?? join(tmpdir(), "nexus-cdp-profile-" + Date.now());
    await mkdir(userDataDir, { recursive: true });
    launched = await launchChromeWithDebug({
      port: opts.port ?? 9222,
      userDataDir,
      headless: opts.headless ?? false,
      url: opts.openUrl,
    });
  }
  const waitMs = opts.waitSeconds && opts.waitSeconds > 0 ? opts.waitSeconds * 1000 : 0;
  if (waitMs > 0) {
    console.error(`[session-capture] waiting ${opts.waitSeconds}s for you to log in...`);
    await new Promise((r) => setTimeout(r, waitMs));
  } else {
    console.error("[session-capture] Press ENTER after you have logged into your dashboards...");
    await waitForEnter();
  }
  const state = await captureSessionFromCdp(opts);
  return { state, launched };
}

export async function captureAndSave(outFile: string, opts: LaunchCaptureOptions = {}): Promise<{ state: SessionStorageState; file: string; launched: LaunchedChrome | null }> {
  const { state, launched } = await launchAndCaptureSession(opts);
  await writeFile(outFile, JSON.stringify(state, null, 2), "utf8");
  return { state, file: outFile, launched };
}