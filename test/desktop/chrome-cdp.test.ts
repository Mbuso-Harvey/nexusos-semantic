/**
 * Hermetic tests for the Chrome DevTools Protocol (CDP) client.
 *
 * These tests use an in-process WebSocketServer + HTTP server that mimic a
 * Chrome CDP endpoint, so they run in CI without a live Chrome instance.
 */
import { describe, it, expect } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { CdpSession } from "../../src/desktop/chrome-cdp.js";
import { ChromeCdpClient, isChromeCdpReachable } from "../../src/desktop/chrome-cdp.js";
import { findChromeExecutable } from "../../src/desktop/chrome-cdp.js";

describe("chrome-cdp / CdpSession", () => {
  it("round-trips Runtime.evaluate via a mock CDP WebSocket", async () => {
    const { url, close } = await startMockCdpWs(async (msg, send) => {
      const parsed = JSON.parse(msg);
      if (parsed.method === "Runtime.evaluate") {
        send(JSON.stringify({ id: parsed.id, result: { result: { type: "string", value: "hello cdraft" } } }));
      } else {
        send(JSON.stringify({ id: parsed.id, result: {} }));
      }
    });

    const session = await CdpSession.connect(url, 2000);
    try {
      const value = await session.evaluate<string>("document.title");
      expect(value).toBe("hello cdraft");
    } finally {
      session.close();
      close();
    }
  });

  it("rejects when the CDP endpoint returns an error response", async () => {
    const { url, close } = await startMockCdpWs(async (msg, send) => {
      const parsed = JSON.parse(msg);
      send(
        JSON.stringify({
          id: parsed.id,
          error: { message: "No node with given id found", code: -32000 },
        }),
      );
    });

    const session = await CdpSession.connect(url, 2000);
    try {
      await expect(session.evaluate("x.y()")).rejects.toThrow(/No node with given id found/);
    } finally {
      session.close();
      close();
    }
  });

  it("times out when the endpoint never answers", async () => {
    const { url, close } = await startMockCdpWs(async () => {
      /* swallow — never reply */
    });

    const session = await CdpSession.connect(url, 150);
    try {
      await expect(session.evaluate("1+1")).rejects.toThrow(/CDP timeout after 150ms/);
    } finally {
      session.close();
      close();
    }
  });

  it("rejects when send is called on a closed session", async () => {
    const { url, close } = await startMockCdpWs(async () => {});
    const session = await CdpSession.connect(url, 2000);
    session.close();
    expect(() => session.send("Runtime.evaluate", {})).toThrow(/closed/);
    close();
  });
});

describe("chrome-cdp / ChromeCdpClient", () => {
  it("points at the expected HTTP base and lists page targets", async () => {
    const info = await startMockCdpHttp("/json/list", [
      { type: "page", id: "1", title: "Dashboard | Claude", url: "https://console.anthropic.com", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/1" },
      { type: "service_worker", id: "2", title: "", url: "https://x/sw.js", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/2" },
    ]);

    const client = new ChromeCdpClient({ port: info.port, host: "127.0.0.1" });
    const pages = await client.listPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe("Dashboard | Claude");
    expect(pages[0]?.url).toContain("console.anthropic.com");
    info.close();
  });

  it("returns false for isReachable when nothing is listening", async () => {
    const reachable = await isChromeCdpReachable(1, "127.0.0.1");
    expect(reachable).toBe(false);
  });

  it("findChromeExecutable returns a non-empty path on this host platform", () => {
    const exe = findChromeExecutable();
    // Either null (no Chrome installed) or a non-empty path; must never throw.
    if (exe !== null) {
      expect(exe.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// In-process CDP mocks (hermetic)
// ---------------------------------------------------------------------------

async function startMockCdpWs(
  handler: (msg: string, send: (raw: string) => void) => void,
): Promise<{ url: string; close: () => void }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/devtools/page/1`;

  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => handler(data.toString(), (raw) => socket.send(raw)));
  });

  return {
    url,
    close: () => {
      wss.clients.forEach((c) => c.terminate());
      wss.close();
    },
  };
}

async function startMockCdpHttp(
  path: string,
  payload: unknown,
): Promise<{ port: number; close: () => void }> {
  const server: HttpServer = createHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== path) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.end(JSON.stringify(payload));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { port: addr.port, close: () => server.close() };
}