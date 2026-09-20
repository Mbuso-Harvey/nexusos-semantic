/**
 * Authenticated Sessions & Storage State Preservation.
 *
 * Provides export, import, and disk persistence for authenticated browser
 * sessions across crawls. Enables crawling authenticated SaaS applications
 * (GitHub, Jira, Linear, internal portals) by preserving cookies,
 * localStorage tokens, and session context.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Page } from "../bidi-client/page.js";
import type { CookieDraft } from "../bidi-client/storage.js";
import type { AuthContext } from "../graph/types.js";

export interface StorageEntry {
  name: string;
  value: string;
}

export interface StorageOriginState {
  origin: string;
  localStorage: StorageEntry[];
  sessionStorage?: StorageEntry[];
}

export interface SessionCookieState {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number | null;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none" | null;
}

export interface SessionStorageState {
  version: "1.0.0";
  createdAt: string;
  cookies: SessionCookieState[];
  origins?: StorageOriginState[];
  headers?: Record<string, string>;
  authContext?: AuthContext;
}

/**
 * Export current session cookies and Web Storage state from a live BiDi Page.
 */
export async function exportSessionStorageState(
  page: Page,
  origins?: string[],
): Promise<SessionStorageState> {
  const cookieRes = await page.storage.getCookies();
  const cookies: SessionCookieState[] = (cookieRes.cookies ?? []).map((c) => ({
    name: c.name,
    value: typeof c.value === "string" ? c.value : (c.value as any)?.value ?? String(c.value),
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));

  const originStates: StorageOriginState[] = [];
  const targetOrigins = origins && origins.length > 0 ? origins : [];

  for (const origin of targetOrigins) {
    try {
      const items = await page.script.evaluate<StorageEntry[]>(
        page.target,
        `(() => {
          const ls = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) ls.push({ name: k, value: localStorage.getItem(k) ?? "" });
          }
          return ls;
        })()`,
      );
      if (Array.isArray(items) && items.length > 0) {
        originStates.push({
          origin,
          localStorage: items,
        });
      }
    } catch {
      // Best-effort storage export
    }
  }

  return {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    cookies,
    origins: originStates.length > 0 ? originStates : undefined,
  };
}

/**
 * Apply saved session cookies and Web Storage state to a live BiDi Page.
 */
export async function applySessionStorageState(
  page: Page,
  state: SessionStorageState,
  baseUrl: string,
): Promise<{ cookiesSet: number; originsInjected: number }> {
  let cookiesSet = 0;
  if (state.cookies && state.cookies.length > 0) {
    const drafts: CookieDraft[] = state.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure ?? false,
      sameSite: c.sameSite ?? "lax",
    }));
    cookiesSet = await page.storage.setCookies(baseUrl, drafts);
  }

  let originsInjected = 0;
  if (state.origins && state.origins.length > 0) {
    for (const originState of state.origins) {
      if (originState.localStorage.length > 0) {
        try {
          const payloadJson = JSON.stringify(originState.localStorage);
          await page.script.evaluate(
            page.target,
            `(() => {
              const items = ${payloadJson};
              for (const item of items) {
                if (item && item.name) {
                  localStorage.setItem(item.name, item.value);
                }
              }
            })()`,
          );
          originsInjected++;
        } catch {
          // Best-effort storage injection
        }
      }
    }
  }

  return { cookiesSet, originsInjected };
}

/**
 * Save auth storage state to a JSON file.
 */
export async function saveAuthStateToFile(
  filePath: string,
  state: SessionStorageState,
): Promise<void> {
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Load auth storage state from a JSON file.
 */
export async function loadAuthStateFromFile(filePath: string): Promise<SessionStorageState> {
  if (!existsSync(filePath)) {
    throw new Error(`Auth state file not found at: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const state = JSON.parse(raw) as SessionStorageState;
  if (state.version !== "1.0.0") {
    throw new Error(`Unsupported auth state version: ${state.version}`);
  }
  return state;
}
