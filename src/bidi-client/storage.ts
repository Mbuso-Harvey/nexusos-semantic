/**
 * Typed wrapper for the BiDi storage module.
 *
 * Per the env-report: getCookies and deleteCookies work. setCookie
 * works with proper params. v1 uses read-only cookies for
 * fingerprinting/bot detection.
 *
 * **PR-8b (item 9).** Added `setCookies(origin, cookies)` so the
 * auth context machinery can configure the principal's session
 * cookie before the page is rendered. This is the real-session
 * configuration: the orchestrator calls this once per
 * (URL × auth-context) pair.
 *
 * **PR-8j T2.** The BiDi `storage` module's command is
 * `storage.setCookie` (singular, taking a single `cookie` object),
 * NOT `storage.setCookies` (plural). The previous
 * implementation issued the non-existent `storage.setCookies`
 * command, which Firefox correctly rejected with
 * `unknown command — storage.setCookies`. The defect was masked
 * because the BiDi-gated tests skipped themselves when no
 * geckodriver was available; with PR-8j making BiDi mandatory,
 * the bug surfaced. `setCookies(origin, cookies)` now issues
 * one `storage.setCookie` call per cookie, which is the
 * spec-correct way to set multiple cookies.
 *
 * Spec: https://w3c.github.io/webdriver-bidi/#module-storage
 *  - `storage.getCookies` (plural)
 *  - `storage.setCookie` (singular)
 *  - `storage.deleteCookies` (plural)
 */
import type { BiDiTransport } from "./transport.js";

export interface Cookie {
  name: string;
  value: { type: "string"; value: string } | { type: "number"; value: number };
  domain: string;
  path: string;
  expires: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none" | null;
}

/** Convenience shape: the cookie fields a caller normally supplies. */
export interface CookieDraft {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: number | null;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none" | null;
}

export interface PartitionKey {
  userContext?: string;
  sourceOrigin?: string;
}

export class StorageApi {
  constructor(private transport: BiDiTransport) {}

  async getCookies(partition?: PartitionKey): Promise<{ cookies: Cookie[]; partitionKey: PartitionKey }> {
    return await this.transport.send("storage.getCookies", partition ? { partition } : {});
  }

  async deleteCookies(partition?: PartitionKey): Promise<void> {
    await this.transport.send("storage.deleteCookies", partition ? { partition } : {});
  }

  /**
   * PR-8b + PR-8j T2: set one or more cookies for a given origin.
   * The BiDi `storage.setCookie` command takes a SINGLE `cookie`
   * object. To set multiple cookies, we issue one call per cookie
   * (the spec does not define a plural variant; setting N cookies
   * is N round-trips, and that's the intended contract).
   *
   * Returns the number of cookies set.
   */
  async setCookies(origin: string, cookies: CookieDraft[]): Promise<number> {
    const host = new URL(origin).hostname;
    for (const c of cookies) {
      const cookie = {
        name: c.name,
        value: { type: "string", value: c.value } as const,
        domain: c.domain ?? host,
        path: c.path ?? "/",
        expires: c.expires ?? null,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
        sameSite: c.sameSite ?? "lax",
      };
      await this.transport.send("storage.setCookie", { cookie });
    }
    return cookies.length;
  }
}
