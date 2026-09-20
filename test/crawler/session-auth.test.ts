/**
 * Unit tests for session-auth: authenticated storage preservation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportSessionStorageState,
  applySessionStorageState,
  saveAuthStateToFile,
  loadAuthStateFromFile,
  type SessionStorageState,
} from "../../src/crawler/session-auth.js";
import type { Page } from "../../src/bidi-client/page.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "awg-auth-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Session Auth State Persistence", () => {
  it("serializes and deserializes auth state from disk cleanly", async () => {
    const authFile = join(dir, "auth-state.json");
    const sampleState: SessionStorageState = {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      cookies: [
        {
          name: "user_session",
          value: "tok_xyz123",
          domain: "github.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "lax",
        },
        {
          name: "logged_in",
          value: "yes",
          domain: "github.com",
        },
      ],
      origins: [
        {
          origin: "https://github.com",
          localStorage: [
            { name: "theme", value: "dark" },
            { name: "color_mode", value: "dark_dimmed" },
          ],
        },
      ],
      headers: {
        Authorization: "Bearer ghp_testtoken12345",
      },
    };

    await saveAuthStateToFile(authFile, sampleState);
    const loaded = await loadAuthStateFromFile(authFile);

    expect(loaded.version).toBe("1.0.0");
    expect(loaded.cookies).toHaveLength(2);
    expect(loaded.cookies[0]?.name).toBe("user_session");
    expect(loaded.cookies[0]?.value).toBe("tok_xyz123");
    expect(loaded.origins).toHaveLength(1);
    expect(loaded.origins?.[0]?.localStorage).toHaveLength(2);
    expect(loaded.headers?.Authorization).toBe("Bearer ghp_testtoken12345");
  });

  it("applies cookies and localStorage to mock Page", async () => {
    const setCookiesMock = vi.fn(async () => 2);
    const evaluateMock = vi.fn(async () => undefined);

    const mockPage = {
      target: { context: "ctx-1" },
      storage: { setCookies: setCookiesMock },
      script: { evaluate: evaluateMock },
    } as unknown as Page;

    const state: SessionStorageState = {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      cookies: [
        { name: "session_id", value: "sess_999", domain: "example.com" },
      ],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "authToken", value: "jwt.secret.token" }],
        },
      ],
    };

    const res = await applySessionStorageState(mockPage, state, "https://example.com");

    expect(res.cookiesSet).toBe(2);
    expect(res.originsInjected).toBe(1);
    expect(setCookiesMock).toHaveBeenCalledTimes(1);
    expect(evaluateMock).toHaveBeenCalledTimes(1);
  });

  it("exports cookies and localStorage from mock Page", async () => {
    const getCookiesMock = vi.fn(async () => ({
      cookies: [
        {
          name: "auth_cookie",
          value: "val_123",
          domain: "example.com",
          path: "/",
          expires: 1800000000,
          httpOnly: true,
          secure: true,
          sameSite: "lax" as const,
        },
      ],
      partitionKey: {},
    }));

    const evaluateMock = vi.fn(async () => [
      { name: "pref", value: "compact" },
    ]);

    const mockPage = {
      target: { context: "ctx-1" },
      storage: { getCookies: getCookiesMock },
      script: { evaluate: evaluateMock },
    } as unknown as Page;

    const exported = await exportSessionStorageState(mockPage, ["https://example.com"]);

    expect(exported.version).toBe("1.0.0");
    expect(exported.cookies).toHaveLength(1);
    expect(exported.cookies[0]?.name).toBe("auth_cookie");
    expect(exported.origins).toHaveLength(1);
    expect(exported.origins?.[0]?.localStorage[0]?.name).toBe("pref");
  });
});
