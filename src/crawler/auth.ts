/**
 * PR-8 2C: auth context machinery.
 *
 * `CrawlAuthContext` lets the user declare which auth context a
 * crawl pass should run under. The orchestrator opens one page per
 * (URL × auth context) and unions the results. The recorded
 * `AuthContext` is then stamped on every State the observed
 * extractor materializes (see `runObservedExtractor`).
 *
 * The v1 demo defaults to `anonymous`. The synthetic demo (T13)
 * uses this machinery to drive multiple crawl passes for the
 * `?as=authenticated:alice:session-1` URL — no live credentials
 * required, the auth context is recorded in the State graph for
 * agent inspection.
 *
 * Spec format (string DSL, one per line):
 *   "anonymous"
 *   "authenticated:<principal>:<session>"
 *   "administrator:<principal>:<session>"
 *   "custom-role:<role>:<principal>:<session>"
 *
 * Per the binding correction 2C, observed evidence may annotate but
 * never assert the auth context. The ContextResolver takes an
 * explicit spec; there is no inference from weak signals.
 *
 * **PR-8b (item 9).** `applyAuthSpec(context, spec, baseUrl)` is
 * the function that turns a spec into a real browser session:
 *   - `anonymous`: no-op.
 *   - `authenticated`: `storage.setCookies` with a `session=<s>` cookie.
 *   - `administrator`: same plus a `role=admin` cookie.
 *   - `custom-role`: `localStorage.awg-token=<s>` plus a role-claim
 *     header (the page reads it via a header-injection shim).
 */
import type { AuthContext } from "../graph/types.js";
import type { Page } from "../bidi-client/page.js";

/** Parse a single auth spec into a typed AuthContext. */
export function parseAuthSpec(spec: string): AuthContext {
  const parts = spec.split(":");
  if (parts[0] === "anonymous" && parts.length === 1) {
    return { kind: "anonymous" };
  }
  if (parts[0] === "authenticated" && parts.length === 3) {
    return { kind: "authenticated", principal: parts[1]!, session: parts[2]! };
  }
  if (parts[0] === "administrator" && parts.length === 3) {
    return { kind: "administrator", principal: parts[1]!, session: parts[2]! };
  }
  if (parts[0] === "custom-role" && parts.length === 4) {
    return { kind: "custom-role", role: parts[1]!, principal: parts[2]!, session: parts[3]! };
  }
  throw new Error(
    `parseAuthSpec: invalid spec "${spec}". ` +
    `Expected one of: "anonymous" | "authenticated:<p>:<s>" | ` +
    `"administrator:<p>:<s>" | "custom-role:<r>:<p>:<s>".`,
  );
}

/**
 * A `CrawlAuthSpec` is a single auth spec (string) or an array of
 * specs (one crawl pass per spec). The orchestrator uses the array
 * form when the user wants to crawl a page under multiple auth
 * contexts.
 */
export type CrawlAuthSpec = string | string[];

/** Resolve a `CrawlAuthSpec` to an array of `AuthContext`s. */
export function resolveAuthContexts(spec: CrawlAuthSpec | undefined): AuthContext[] {
  if (spec == null) return [{ kind: "anonymous" }];
  if (typeof spec === "string") return [parseAuthSpec(spec)];
  return spec.map(parseAuthSpec);
}

/** String form of an `AuthContext` (lossless round-trip). */
export function authContextToString(ctx: AuthContext): string {
  switch (ctx.kind) {
    case "anonymous": return "anonymous";
    case "authenticated": return `authenticated:${ctx.principal}:${ctx.session}`;
    case "administrator": return `administrator:${ctx.principal}:${ctx.session}`;
    case "custom-role": return `custom-role:${ctx.role}:${ctx.principal}:${ctx.session}`;
  }
}

// ----- PR-8b (item 9): real browser-session configuration -----

/** The kind of credentials the spec describes. */
export type AuthSpec =
  | { kind: "anonymous" }
  | { kind: "authenticated"; principal: string; session: string }
  | { kind: "administrator"; principal: string; session: string }
  | { kind: "custom-role"; role: string; principal: string; session: string };

/** Parse a `CrawlAuthSpec` into typed `AuthSpec`s. Same parsing as
 *  `parseAuthSpec` but typed structurally. */
export function parseAuthSpecs(spec: CrawlAuthSpec | undefined): AuthSpec[] {
  if (spec == null) return [{ kind: "anonymous" }];
  if (typeof spec === "string") return [parseAuthSpec(spec) as AuthSpec];
  return spec.map((s) => parseAuthSpec(s) as AuthSpec);
}

/** String form of an `AuthSpec` (lossless round-trip). */
export function authSpecToString(spec: AuthSpec): string {
  return authContextToString(spec);
}

/** PR-8b (item 9): the result of applying an auth spec to a page. */
export interface AppliedAuth {
  /** The canonical AuthContext to stamp on every State. */
  context: AuthContext;
  /** Number of BiDi calls made (cookies set, headers injected, etc.). */
  bidiCalls: number;
}

/**
 * Apply an auth spec to a real BiDi `Page` by configuring cookies
 * via BiDi `storage.setCookies`. Returns the canonical
 * `AuthContext` plus a count of BiDi calls made.
 *
 * **Item 9 (PR-8b).** Before PR-8b, the auth context was *only*
 * recorded on each State; no actual session was configured. PR-8b
 * injects the principal's session cookie / Bearer token so the page
 * is genuinely rendered under the specified context.
 *
 * **PR-8d (T6).** Before PR-8d, the `custom-role` branch wrote to
 * `localStorage` via `script.evaluate`. `localStorage` is scoped
 * per-origin; the call ran on the empty `about:blank` document
 * before the orchestrator's `page.navigate()`, and the writes
 * never made it to the target origin. Cookies set via
 * `storage.setCookies` are attached to the target origin by BiDi
 * before the navigation and survive every subsequent navigation,
 * so all four auth kinds now use BiDi cookies exclusively:
 *
 *   - `authenticated`  -> cookies: session, principal
 *   - `administrator`  -> cookies: session, principal, role=admin
 *   - `custom-role`    -> cookies: session, principal, awg-role=<role>
 *
 * The page reads principal/role from `document.cookie` (or via a
 * fetch interceptor that copies cookies into a request header,
 * if the page's API doesn't accept cookies).
 */
export async function applyAuthSpec(
  page: Page,
  spec: AuthSpec,
  baseUrl: string,
): Promise<AppliedAuth> {
  let bidiCalls = 0;
  if (spec.kind === "anonymous") {
    return { context: { kind: "anonymous" }, bidiCalls };
  }
  const cookieBaseUrl = baseUrl || "https://localhost/";
  if (spec.kind === "authenticated") {
    await page.storage.setCookies(cookieBaseUrl, [
      { name: "session", value: spec.session, path: "/", sameSite: "lax" },
      { name: "principal", value: spec.principal, path: "/", sameSite: "lax" },
    ]);
    bidiCalls++;
    return {
      context: { kind: "authenticated", principal: spec.principal, session: spec.session },
      bidiCalls,
    };
  }
  if (spec.kind === "administrator") {
    await page.storage.setCookies(cookieBaseUrl, [
      { name: "session", value: spec.session, path: "/", sameSite: "lax" },
      { name: "principal", value: spec.principal, path: "/", sameSite: "lax" },
      { name: "role", value: "admin", path: "/", sameSite: "lax" },
    ]);
    bidiCalls++;
    return {
      context: { kind: "administrator", principal: spec.principal, session: spec.session },
      bidiCalls,
    };
  }
  // custom-role: same cookie surface, with `awg-role` carrying the
  // role claim. The page reads the claim from `document.cookie`
  // and applies its own role-based authorization.
  await page.storage.setCookies(cookieBaseUrl, [
    { name: "session", value: spec.session, path: "/", sameSite: "lax" },
    { name: "principal", value: spec.principal, path: "/", sameSite: "lax" },
    { name: "awg-role", value: spec.role, path: "/", sameSite: "lax" },
  ]);
  bidiCalls++;
  return {
    context: { kind: "custom-role", role: spec.role, principal: spec.principal, session: spec.session },
    bidiCalls,
  };
}
