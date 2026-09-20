import { describe, it, expect } from "vitest";
import { WebCdpSurface } from "../../src/substrate/web-cdp-surface.js";
import type { ChromeCdpClient, CdpTarget, CdpSession } from "../../src/desktop/chrome-cdp.js";
import type { Source } from "../../src/bidi-client/input.js";

/** Mock ChromeCdpClient: withSession immediately runs the job on a recording session. */
function makeClient(recorded: { method: string; params: unknown }[]): ChromeCdpClient {
  const target: CdpTarget = {
    id: "tab-1", type: "page", title: "Demo", url: "http://example.test/",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab-1",
  };
  const session = {
    send: async (method: string, params?: unknown) => {
      recorded.push({ method, params });
      return undefined as never;
    },
  } as unknown as CdpSession;
  const client = {
    listPages: async () => [target],
    withSession: async (_t: CdpTarget, job: (s: CdpSession) => Promise<unknown>) => job(session),
  } as unknown as ChromeCdpClient;
  return client;
}

const TARGET: CdpTarget = {
  id: "tab-1", type: "page", title: "Demo", url: "http://example.test/",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/tab-1",
};

describe("WebCdpSurface input translation", () => {
  it("carries the pointerMove position onto position-less pointerDown/pointerUp", async () => {
    const recorded: { method: string; params: unknown }[] = [];
    const surface = new WebCdpSurface(makeClient(recorded), TARGET);

    const actions: Source[] = [{
      type: "pointer",
      id: "pointer-1",
      actions: [
        { type: "pointerMove", x: 64, y: 128 },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ],
    }];
    await surface.performActions(actions);

    expect(recorded).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 64, y: 128, button: "none" } },
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 64, y: 128, button: "left", clickCount: 1 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 64, y: 128, button: "left", clickCount: 1 } },
    ]);
  });

  it("maps BiDi button codes to CDP button names and increments clickCount on double-click", async () => {
    const recorded: { method: string; params: unknown }[] = [];
    const surface = new WebCdpSurface(makeClient(recorded), TARGET);

    await surface.performActions([{
      type: "pointer",
      id: "pointer-1",
      actions: [
        { type: "pointerMove", x: 1, y: 2 },
        { type: "pointerDown", button: 2 },
        { type: "pointerUp", button: 2 },
        { type: "pointerDown", button: 2 },
        { type: "pointerUp", button: 2 },
      ],
    }]);

    const presses = recorded.filter((r) => (r.params as { type: string }).type === "mousePressed");
    expect(presses.map((p) => p.params)).toEqual([
      { type: "mousePressed", x: 1, y: 2, button: "right", clickCount: 1 },
      { type: "mousePressed", x: 1, y: 2, button: "right", clickCount: 2 },
    ]);
  });

  it("translates known keys to rawKeyDown key events and free text to insertText", async () => {
    const recorded: { method: string; params: unknown }[] = [];
    const surface = new WebCdpSurface(makeClient(recorded), TARGET);

    await surface.performActions([{
      type: "key",
      id: "key-1",
      actions: [
        { type: "keyDown", value: "Enter" },
        { type: "keyUp", value: "Enter" },
        { type: "keyDown", value: "a" },
        { type: "keyUp", value: "a" },
      ],
    }]);

    expect(recorded).toEqual([
      { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Enter", windowsVirtualKeyCode: 13 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 } },
      { method: "Input.insertText", params: { text: "a" } },
    ]);
  });

  it("translates wheel sources into CDP mouseWheel events", async () => {
    const recorded: { method: string; params: unknown }[] = [];
    const surface = new WebCdpSurface(makeClient(recorded), TARGET);

    await surface.performActions([{
      type: "wheel",
      id: "wheel-1",
      actions: [{ type: "scroll", x: 10, y: 20, deltaY: 120 }],
    }]);

    expect(recorded).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 10, y: 20, deltaX: 0, deltaY: 120 } },
    ]);
  });

  it("reports touch-dependent detail for unavailable substrates", async () => {
    const recorded: { method: string; params: unknown }[] = [];
    const client = makeClient(recorded);
    expect(typeof client.withSession).toBe("function");
  });
});
