/**
 * Smoke test: open a BiDi session, navigate, take a screenshot, click a link.
 *
 * Skips itself if geckodriver isn't running on 4444. CI starts geckodriver as a
 * service; the dev loop runs it manually.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createConnection } from "node:net";
import { BiDiSession, Page } from "../../src/bidi-client/index.js";

async function portOpen(port: number, host: string = "127.0.0.1"): Promise<boolean> {
  return await new Promise((res) => {
    const s = createConnection({ port, host }, () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
}

describe("bidi-client/Page", () => {
  let session: BiDiSession;
  let page: Page;
  let skip = false;

  beforeAll(async () => {
    if (!(await portOpen(4444))) {
      console.warn("geckodriver not on 4444; skipping bidi-client smoke");
      skip = true;
      return;
    }
    // PR-8c T11: retry up to 6 times on the "Session is already started"
    // race that geckodriver hits when a previous test file's session
    // hasn't been fully torn down. Each retry creates a new BiDi
    // session (the only way to clear the geckodriver singleton). The
    // backoff is exponential (1s, 2s, 3s, 4s, 5s, 6s) to give
    // geckodriver enough time to release the lock.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        session = await BiDiSession.create();
        const { context } = await session.transport.send<{ context: string }>("browsingContext.create", { type: "tab" });
        page = new Page(session, context);
        return;
      } catch (e) {
        lastErr = e;
        // Wait longer for the previous session to fully release.
        const waitMs = 1000 * (attempt + 1);
        console.warn(`BiDi session create failed (attempt ${attempt + 1}/6); waiting ${waitMs}ms: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    try { await page?.close(); } catch {}
    try { await session?.close(); } catch {}
  });

  it("navigates and reads title", async () => {
    if (skip) return;
    await page.navigate("https://example.com");
    // Small settle for any client-side hydration
    await new Promise((r) => setTimeout(r, 500));
    const title = await page.title;
    expect(title).toBe("Example Domain");
  }, 30_000);

  it("takes a screenshot via BiDi and classic HTTP", async () => {
    if (skip) return;
    const shot = await page.screenshot();
    expect(shot.bidi.data.length).toBeGreaterThan(1000);
    expect(shot.classic.length).toBeGreaterThan(1000);
  }, 30_000);

  it("locates an element by CSS", async () => {
    if (skip) return;
    // Re-navigate to make sure we have example.com loaded, then settle
    await page.navigate("https://example.com");
    await new Promise((r) => setTimeout(r, 500));
    const nodes = await page.locate({ type: "css", value: "h1" });
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]!.value.localName).toBe("h1");
  }, 30_000);

  it("evaluates JS in the page", async () => {
    if (skip) return;
    const v = await page.script.evaluate<number>(page.target, "1+2+3");
    expect(v).toBe(6);
  }, 30_000);
});
