/**
 * Unit tests for the PR-8 2C auth spec parser/resolver.
 *
 * The parser takes a string DSL and returns a typed AuthContext;
 * the resolver expands a single spec or an array of specs to
 * AuthContext[] for multi-pass crawls.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseAuthSpec,
  resolveAuthContexts,
  authContextToString,
  applyAuthSpec,
  type AuthSpec,
} from "../../src/crawler/auth.js";
import type { Page } from "../../src/bidi-client/page.js";
import type { ScriptApi, ScriptTarget } from "../../src/bidi-client/script.js";
import type { BiDiTransport } from "../../src/bidi-client/transport.js";
import type { BrowsingContextApi } from "../../src/bidi-client/browsing-context.js";
import type { BiDiSession } from "../../src/bidi-client/session.js";
import type { CookieDraft } from "../../src/bidi-client/storage.js";

describe("parseAuthSpec", () => {
  it("parses 'anonymous'", () => {
    expect(parseAuthSpec("anonymous")).toEqual({ kind: "anonymous" });
  });

  it("parses 'authenticated:<p>:<s>'", () => {
    expect(parseAuthSpec("authenticated:alice:session-1")).toEqual({
      kind: "authenticated", principal: "alice", session: "session-1",
    });
  });

  it("parses 'administrator:<p>:<s>'", () => {
    expect(parseAuthSpec("administrator:bob:session-2")).toEqual({
      kind: "administrator", principal: "bob", session: "session-2",
    });
  });

  it("parses 'custom-role:<r>:<p>:<s>'", () => {
    expect(parseAuthSpec("custom-role:billing-admin:carol:session-3")).toEqual({
      kind: "custom-role", role: "billing-admin", principal: "carol", session: "session-3",
    });
  });

  it("throws on malformed spec", () => {
    expect(() => parseAuthSpec("authenticated:alice")).toThrow(/invalid spec/);
    expect(() => parseAuthSpec("administrator:bob:session-2:extra")).toThrow(/invalid spec/);
    expect(() => parseAuthSpec("custom-role:billing-admin:carol")).toThrow(/invalid spec/);
    expect(() => parseAuthSpec("anonymous:extra")).toThrow(/invalid spec/);
    expect(() => parseAuthSpec("")).toThrow(/invalid spec/);
  });
});

describe("resolveAuthContexts", () => {
  it("returns [anonymous] when spec is undefined", () => {
    expect(resolveAuthContexts(undefined)).toEqual([{ kind: "anonymous" }]);
  });

  it("returns [single ctx] for a string spec", () => {
    expect(resolveAuthContexts("administrator:alice:session-1")).toEqual([
      { kind: "administrator", principal: "alice", session: "session-1" },
    ]);
  });

  it("returns the array as-is when spec is an array", () => {
    const ctxs = resolveAuthContexts([
      "anonymous",
      "authenticated:alice:s1",
      "administrator:bob:s2",
    ]);
    expect(ctxs).toHaveLength(3);
    expect(ctxs[0]).toEqual({ kind: "anonymous" });
    expect(ctxs[1]).toEqual({ kind: "authenticated", principal: "alice", session: "s1" });
    expect(ctxs[2]).toEqual({ kind: "administrator", principal: "bob", session: "s2" });
  });

  it("throws on a malformed entry in the array", () => {
    expect(() => resolveAuthContexts(["anonymous", "bad:spec"])).toThrow(/invalid spec/);
  });
});

describe("authContextToString", () => {
  it("round-trips every AuthContext variant", () => {
    const cases: Array<[string, ReturnType<typeof parseAuthSpec>]> = [
      ["anonymous", { kind: "anonymous" }],
      ["authenticated:alice:s1", { kind: "authenticated", principal: "alice", session: "s1" }],
      ["administrator:bob:s2", { kind: "administrator", principal: "bob", session: "s2" }],
      ["custom-role:role-x:carol:s3", { kind: "custom-role", role: "role-x", principal: "carol", session: "s3" }],
    ];
    for (const [expected, ctx] of cases) {
      expect(authContextToString(ctx)).toBe(expected);
      expect(parseAuthSpec(expected)).toEqual(ctx);
    }
  });
});

/**
 * PR-8d T6: real cookie-based session application via BiDi
 * `storage.setCookies`. Before PR-8d the `custom-role` branch
 * wrote to `localStorage` via `script.evaluate`. `localStorage`
 * is scoped per-origin; the call ran on the empty `about:blank`
 * document before the orchestrator's `page.navigate()`, so the
 * writes never made it to the target origin. PR-8d moves all
 * four auth kinds to BiDi `storage.setCookies`, which attaches
 * the cookies to the target origin before the navigation and
 * survives every subsequent navigation.
 */
describe("PR-8d T6: applyAuthSpec uses BiDi cookies (survives navigation)", () => {
  function makeMockPage() {
    const setCookiesMock = vi.fn(async (_origin: string, _cookies: CookieDraft[]) => {
      return 1; // BiDi's storage.setCookies returns the number of cookies set.
    });
    const evaluateMock = vi.fn();
    const ctx = "ctx-test-1";
    const page = {
      context: ctx,
      bc: { onLoad: vi.fn(() => () => undefined) } as unknown as BrowsingContextApi,
      script: { callFunction: vi.fn(), evaluate: evaluateMock } as unknown as ScriptApi,
      target: { context: ctx } as ScriptTarget,
      storage: { setCookies: setCookiesMock } as any,
    } as unknown as Page;
    return { page, setCookiesMock, evaluateMock };
  }

  it("anonymous: does NOT call setCookies (no session to apply)", async () => {
    const { page, setCookiesMock } = makeMockPage();
    const result = await applyAuthSpec(page, { kind: "anonymous" }, "https://example.com/");
    expect(setCookiesMock).not.toHaveBeenCalled();
    expect(result.context).toEqual({ kind: "anonymous" });
    expect(result.bidiCalls).toBe(0);
  });

  it("authenticated: sets session + principal cookies via BiDi storage.setCookies", async () => {
    const { page, setCookiesMock } = makeMockPage();
    const result = await applyAuthSpec(
      page,
      { kind: "authenticated", principal: "alice", session: "sess-1" },
      "https://example.com/",
    );
    expect(setCookiesMock).toHaveBeenCalledTimes(1);
    const [origin, cookies] = setCookiesMock.mock.calls[0]!;
    expect(origin).toBe("https://example.com/");
    expect(cookies).toEqual([
      expect.objectContaining({ name: "session", value: "sess-1" }),
      expect.objectContaining({ name: "principal", value: "alice" }),
    ]);
    expect(result.context).toEqual({ kind: "authenticated", principal: "alice", session: "sess-1" });
    expect(result.bidiCalls).toBe(1);
  });

  it("administrator: sets session + principal + role=admin cookies", async () => {
    const { page, setCookiesMock } = makeMockPage();
    const result = await applyAuthSpec(
      page,
      { kind: "administrator", principal: "bob", session: "sess-2" },
      "https://example.com/",
    );
    const [, cookies] = setCookiesMock.mock.calls[0]!;
    expect(cookies).toEqual([
      expect.objectContaining({ name: "session", value: "sess-2" }),
      expect.objectContaining({ name: "principal", value: "bob" }),
      expect.objectContaining({ name: "role", value: "admin" }),
    ]);
    expect(result.context).toEqual({ kind: "administrator", principal: "bob", session: "sess-2" });
  });

  it("PR-8d T6: custom-role uses cookies (NOT localStorage) so the role survives navigation", async () => {
    const { page, setCookiesMock, evaluateMock } = makeMockPage();
    const result = await applyAuthSpec(
      page,
      { kind: "custom-role", role: "billing-admin", principal: "carol", session: "sess-3" },
      "https://example.com/",
    );
    // The fix: custom-role now uses BiDi cookies. No localStorage writes.
    expect(setCookiesMock).toHaveBeenCalledTimes(1);
    expect(evaluateMock).not.toHaveBeenCalled();
    const [, cookies] = setCookiesMock.mock.calls[0]!;
    expect(cookies).toEqual([
      expect.objectContaining({ name: "session", value: "sess-3" }),
      expect.objectContaining({ name: "principal", value: "carol" }),
      expect.objectContaining({ name: "awg-role", value: "billing-admin" }),
    ]);
    expect(result.context).toEqual({
      kind: "custom-role",
      role: "billing-admin",
      principal: "carol",
      session: "sess-3",
    });
  });

  it("falls back to https://localhost/ when baseUrl is empty (no host omitted)", async () => {
    const { page, setCookiesMock } = makeMockPage();
    await applyAuthSpec(
      page,
      { kind: "authenticated", principal: "alice", session: "s1" },
      "",
    );
    const [origin] = setCookiesMock.mock.calls[0]!;
    expect(origin).toBe("https://localhost/");
  });

  it("every auth kind routes through BiDi storage (no script.evaluate for credentials)", async () => {
    // The orchestrator calls `applyAuthSpec` BEFORE `page.navigate`,
    // so the cookies are attached to the target origin before the
    // first request. localStorage writes on `about:blank` would
    // never reach the target origin, so they are NOT a substitute
    // for cookies.
    const cases: AuthSpec[] = [
      { kind: "authenticated", principal: "alice", session: "s1" },
      { kind: "administrator", principal: "bob", session: "s2" },
      { kind: "custom-role", role: "ops", principal: "carol", session: "s3" },
    ];
    for (const spec of cases) {
      const { page, setCookiesMock, evaluateMock } = makeMockPage();
      await applyAuthSpec(page, spec, "https://example.com/");
      expect(setCookiesMock, `${spec.kind} must call setCookies`).toHaveBeenCalledTimes(1);
      // No localStorage writes for any auth kind.
      expect(
        evaluateMock,
        `${spec.kind} must NOT call script.evaluate (cookies, not localStorage)`,
      ).not.toHaveBeenCalled();
    }
  });
});
