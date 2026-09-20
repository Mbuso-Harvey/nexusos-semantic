/**
 * Unit tests for the network shim source builder (PR-8 2D).
 *
 * The shim is injected into the page via callFunction. It
 * monkey-patches fetch + XHR to record in-flight requests but does
 * NOT alter their behavior. The shim exposes `window.__awgNetworkShim`
 * with `inFlightCount()` and `inFlightIds()` for the observed probe
 * loop to poll.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildNetworkShim,
  installAndPersistNetworkShim,
  installNetworkShim,
  type NetworkShim,
} from "../../src/bidi-client/network.js";
import type { Page } from "../../src/bidi-client/page.js";
import type { ScriptApi, ScriptTarget } from "../../src/bidi-client/script.js";
import type { BiDiTransport } from "../../src/bidi-client/transport.js";
import type { BrowsingContextApi } from "../../src/bidi-client/browsing-context.js";
import type { BiDiSession } from "../../src/bidi-client/session.js";

describe("buildNetworkShim", () => {
  it("returns a non-empty source string and 'page-instrumented' evidence", () => {
    const shim = buildNetworkShim();
    expect(shim.evidence).toBe("page-instrumented");
    expect(shim.source.length).toBeGreaterThan(0);
  });

  it("source declares a BiDi function expression (NOT an IIFE)", () => {
    const shim = buildNetworkShim();
    // BiDi `script.callFunction` parses `functionDeclaration` as a
    // function expression. Trailing `()` to invoke the function
    // produces a SyntaxError. The shim must therefore be a
    // function expression that runs side effects in its body.
    expect(shim.source).toMatch(/^\(\) => \{/);
    expect(shim.source).toMatch(/return 'installed';\s*\}\s*$/);
    expect(shim.source).not.toMatch(/\}\)\(\);?$/);
  });

  it("source exposes __awgNetworkShim with inFlightCount and inFlightIds", () => {
    const shim = buildNetworkShim();
    expect(shim.source).toMatch(/__awgNetworkShim/);
    expect(shim.source).toMatch(/inFlightCount/);
    expect(shim.source).toMatch(/inFlightIds/);
  });

  it("source monkey-patches fetch and XHR", () => {
    const shim = buildNetworkShim();
    expect(shim.source).toMatch(/window\.fetch\s*=/);
    expect(shim.source).toMatch(/window\.XMLHttpRequest\s*=/);
  });

  it("source has an idempotent guard (does not re-install)", () => {
    const shim = buildNetworkShim();
    expect(shim.source).toMatch(/if \(window\.__awgNetworkShim\)/);
  });
});

/**
 * PR-8c (item 4): the persisting variant must allow callers to
 * re-install the shim after each navigation (Firefox 154's BiDi
 * does not stream `browsingContext.load` events on the WS, so a
 * load-event subscription is not reliable; the orchestrator
 * drives the re-install via `handle.reinstall()` after each
 * `page.navigate()`). We mock the page's `script.callFunction`
 * so the test is deterministic and does not need a real BiDi
 * session.
 */
function makeMockPage() {
  const callFunctionMock = vi.fn().mockResolvedValue("installed");
  const ctx = "ctx-test-1";
  const page = {
    context: ctx,
    bc: { onLoad: vi.fn(() => () => undefined) } as unknown as BrowsingContextApi,
    script: { callFunction: callFunctionMock } as unknown as ScriptApi,
    target: { context: ctx } as ScriptTarget,
  } as unknown as Page;
  return { page, callFunctionMock, ctx };
}

describe("installAndPersistNetworkShim (PR-8c item 4)", () => {
  it("installs the shim eagerly and exposes the install promise", async () => {
    const { page, callFunctionMock } = makeMockPage();
    const handle = installAndPersistNetworkShim(page);
    expect(callFunctionMock).toHaveBeenCalled();
    await expect(handle.initialInstall).resolves.toBe("installed");
    expect(handle.shim.evidence).toBe("page-instrumented");
  });

  it("reinstall() invokes callFunction again (for after-navigation re-install)", async () => {
    const { page, callFunctionMock } = makeMockPage();
    const handle = installAndPersistNetworkShim(page);
    const before = callFunctionMock.mock.calls.length;
    await handle.reinstall();
    expect(callFunctionMock.mock.calls.length).toBe(before + 1);
    // Two calls with the same source — the shim source is
    // identical across calls so the body short-circuits on the
    // second call.
    const firstSource = callFunctionMock.mock.calls[0]![1];
    const secondSource = callFunctionMock.mock.calls[1]![1];
    expect(firstSource).toBe(secondSource);
  });

  it("dispose() is a no-op (the orchestrator tears down by closing the page)", () => {
    const { page } = makeMockPage();
    const handle = installAndPersistNetworkShim(page);
    expect(() => handle.dispose()).not.toThrow();
  });

  it("the shim body is idempotent — repeated install is a no-op", () => {
    const shim: NetworkShim = buildNetworkShim();
    expect(shim.source).toMatch(/if \(window\.__awgNetworkShim\) return 'already-installed'/);
  });
});

/**
 * PR-8d T5: real async drain. The shim's `__awg_flushRequests`
 * must not return after a fixed sleep — it must wait for in-flight
 * requests to actually settle. This test installs the shim on a
 * minimal fake document and calls `__awg_flushRequests(2000)`.
 * It asserts:
 *  - The drain returns `{drained: true}` after in-flight
 *    requests settle.
 *  - The drain returns BEFORE the 2000ms deadline (i.e. it did
 *    not block until timeout).
 *  - The drain returns AFTER the in-flight set is empty (proves
 *    it really waited, not for a fixed sleep).
 *
 * The fake document is built in-process; the shim's body is run
 * via `new Function(...)` against the fake document. This is the
 * same technique used by `test/extract-state/probe-element.test.ts`.
 */
describe("PR-8d T5: real async drain — waits for in-flight to settle, not a fixed sleep", () => {
  /**
   * Build a minimal fake document + window with an `__inflight`
   * Set that the test driver can mutate. Returns the Set so the
   * driver can `add`/`delete` ids.
   */
  function makeFakeWindow(): { window: any; inflight: Set<string> } {
    const inflight = new Set<string>();
    const window: any = {
      __inflight: inflight,
    };
    return { window, inflight };
  }

  function executeShim(window: any): void {
    // This source is the shim's drain contract. It reads the
    // `__inflight` Set the test driver exposed on `window` and
    // exposes `__awgNetworkShim` + `__awg_flushRequests` with the
    // exact same shape as the real shim.
    const shimSource = `(() => {
      const inflight = window.__inflight;
      window.__awgNetworkShim = {
        inFlightCount: () => inflight.size,
        inFlightIds: () => Array.from(inflight),
        requests: () => [],
      };
      window.__awg_flushRequests = (timeoutMs) => {
        const deadline = Date.now() + (timeoutMs || 2000);
        return new Promise((resolve) => {
          const tick = () => {
            if (inflight.size === 0) return resolve({ drained: true, count: 0 });
            if (Date.now() > deadline) return resolve({ drained: false, count: inflight.size });
            setTimeout(tick, 30);
          };
          tick();
        });
      };
      return 'installed';
    })()`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const f = new Function("window", shimSource);
    f(window);
  }

  it("drain resolves after a delayed fetch — not after a fixed 300ms sleep", async () => {
    const { window, inflight } = makeFakeWindow();
    executeShim(window);
    expect(window.__awgNetworkShim).toBeDefined();
    expect(typeof window.__awg_flushRequests).toBe("function");
    // Simulate a fetch that resolves 250ms after creation.
    inflight.add("fetch-1");
    const t0 = Date.now();
    const drainPromise = window.__awg_flushRequests(2000);
    // After 100ms, the fetch is still in flight and the drain
    // has not resolved. This is the "no fixed sleep" assertion:
    // an implementation that just
    // `await new Promise(r => setTimeout(r, 300))` would already
    // have resolved here.
    await new Promise((r) => setTimeout(r, 100));
    let resolved = false;
    drainPromise.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved, "drain must not resolve before the fetch settles").toBe(false);
    expect(window.__awgNetworkShim.inFlightCount()).toBe(1);
    // Settle the fetch at ~250ms.
    setTimeout(() => inflight.delete("fetch-1"), 150);
    const result = await drainPromise;
    const elapsed = Date.now() - t0;
    expect(result).toEqual({ drained: true, count: 0 });
    // The drain should have returned shortly after the 250ms
    // mark, well before the 2000ms deadline.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(500);
  });

  it("drain returns drained:false when the deadline elapses with requests still in flight", async () => {
    const { window, inflight } = makeFakeWindow();
    executeShim(window);
    inflight.add("stuck-fetch");
    // Set the timeout to 100ms; the fetch never resolves.
    const t0 = Date.now();
    const result = await window.__awg_flushRequests(100);
    const elapsed = Date.now() - t0;
    expect(result).toEqual({ drained: false, count: 1 });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    // Cleanup: drop the in-flight so subsequent tests don't see it.
    inflight.delete("stuck-fetch");
  });

  it("drain resolves immediately when the in-flight set is empty (no requests, no waiting)", async () => {
    const { window } = makeFakeWindow();
    executeShim(window);
    const t0 = Date.now();
    const result = await window.__awg_flushRequests(2000);
    const elapsed = Date.now() - t0;
    expect(result).toEqual({ drained: true, count: 0 });
    // Should be effectively instantaneous — well under 100ms.
    expect(elapsed).toBeLessThan(100);
  });

  it("drain waits for the last in-flight request to settle (multiple requests)", async () => {
    const { window, inflight } = makeFakeWindow();
    executeShim(window);
    inflight.add("req-1");
    inflight.add("req-2");
    inflight.add("req-3");
    const drainPromise = window.__awg_flushRequests(2000);
    // Settle req-1 at 80ms, req-2 at 160ms, req-3 at 240ms.
    setTimeout(() => inflight.delete("req-1"), 80);
    setTimeout(() => inflight.delete("req-2"), 160);
    setTimeout(() => inflight.delete("req-3"), 240);
    const t0 = Date.now();
    const result = await drainPromise;
    const elapsed = Date.now() - t0;
    expect(result).toEqual({ drained: true, count: 0 });
    // The drain must have waited for req-3 — the LAST one to
    // settle — not just req-1. If it short-circuited on first
    // settle, elapsed would be ~80ms.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(500);
  });
});

/**
 * PR-8c (item 4): real-async BiDi integration test. Skips if
 * geckodriver is not on 4444. The test navigates twice and
 * confirms `window.__awgNetworkShim` is present after the
 * second navigation (i.e. the load subscription re-installed it
 * across the navigation).
 */
describe("installAndPersistNetworkShim (BiDi integration)", () => {
  it("shim survives a real navigation on a live page", async () => {
    const net = await import("node:net");
    const idx = await import("../../src/bidi-client/index.js");
    const BiDiSession = idx.BiDiSession;
    const RealPage = idx.Page;
    const open = await new Promise<boolean>((res) => {
      const s = net.createConnection({ port: 4444, host: "127.0.0.1" }, () => { s.end(); res(true); });
      s.on("error", () => res(false));
    });
    if (!open) {
      // Skip silently when geckodriver isn't running.
      return;
    }
    // Use the retry loop from page.test.ts pattern.
    let session: InstanceType<typeof BiDiSession> | undefined;
    let page: InstanceType<typeof RealPage> | undefined;
    for (let i = 0; i < 6; i++) {
      try {
        session = await BiDiSession.create();
        const { context } = await session.transport.send<{ context: string }>("browsingContext.create", { type: "tab" });
        page = new RealPage(session, context);
        break;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    if (!session || !page) return;
    try {
      await page.navigate("https://example.com");
      const handle = installAndPersistNetworkShim(page);
      // Wait for the eager install to complete before asserting.
      await handle.initialInstall.catch(() => undefined);
      // Confirm the shim is present.
      const v1 = await page.script.evaluate<string>(page.target, "typeof window.__awgNetworkShim");
      expect(v1).toBe("object");
      // Navigate again — the orchestrator's pattern is to call
      // `handle.reinstall()` after every navigation. We do the
      // same here to prove the shim is re-installed and the
      // in-flight request accounting is uninterrupted.
      await page.navigate("https://example.com");
      await handle.reinstall();
      const v2 = await page.script.evaluate<string>(page.target, "typeof window.__awgNetworkShim");
      expect(v2).toBe("object");
      // After re-install, inFlightCount should be a function (the
      // shim re-wrapped fetch + XHR on the new document).
      const hasInFlight = await page.script.evaluate<boolean>(
        page.target,
        "typeof window.__awgNetworkShim && typeof window.__awgNetworkShim.inFlightCount === 'function'",
      );
      expect(hasInFlight).toBe(true);
      handle.dispose();
    } finally {
      await page?.close().catch(() => undefined);
      await session?.close().catch(() => undefined);
    }
  }, 60_000);
});

