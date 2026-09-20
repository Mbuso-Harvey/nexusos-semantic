/**
 * Hermetic tests for Chrome session capture (session-capture.ts).
 *
 * Uses the same in-process mock CDP pattern as chrome-cdp.test.ts:
 * a WebSocketServer + HTTP server that mimic Chrome's CDP endpoint.
 * No live Chrome required.
 */
import { describe, it, expect } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { captureSessionFromCdp } from "../../src/desktop/session-capture.js";

let portCounter = 9100;

async function startMockCdp(opts: {
  pages: Array<{ id: string; title: string; url: string }>;
  cookies: Array<{ name: string; value: string; domain: string; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; expires?: number }>;
  storage: Array<{ url: string; localStorage: Record<string, string>; sessionStorage?: Record<string, string> }>;
}): Promise<{ port: number; close: () => void }> {
  const httpServer: HttpServer = createHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ Browser: "Chrome/120.0.0.0", "Protocol-Version": "1.3" }));
    } else if (req.url === "/json/list") {
      res.end(JSON.stringify(opts.pages.map((p) => ({
        type: "page", id: p.id, title: p.title, url: p.url,
        webSocketDebuggerUrl: `ws://127.0.0.1:${combinedPort}/devtools/page/${p.id}`,
      }))));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });

  const wss = new WebSocketServer({ port: 0 });
  const wsPort = (wss.address() as { port: number }).port;
  // Re-bind http to same port as ws for simplicity in this mock
  // (we use a single combined port for both in this mock)

  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: msg.id, result }));
      const method: string = msg.method;
      if (method === "Network.getAllCookies") {
        reply({ cookies: opts.cookies });
      } else if (method === "Runtime.evaluate") {
        const expr: string = msg.params?.expression ?? "";
        if (expr.includes("localStorage.getItem")) {
          const matched = opts.storage.find((s) => expr.length > 0);
          reply({ result: { type: "object", value: matched?.localStorage ?? {} } });
        } else if (expr.includes("sessionStorage.getItem")) {
          const matched = opts.storage.find((s) => expr.length > 0);
          reply({ result: { type: "object", value: matched?.sessionStorage ?? {} } });
        } else {
          reply({ result: { type: "string", value: "" } });
        }
      } else {
        reply({});
      }
    });
  });

  // Combined server: http for /json/*, ws for /devtools/*
  const combinedPort = portCounter;
  portCounter++;

  // We need both http and ws on the same port. Use httpServer for HTTP and attach ws upgrade.
  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  await new Promise<void>((resolve) => httpServer.listen(combinedPort, "127.0.0.1", resolve));

  return {
    port: combinedPort,
    close: () => {
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      httpServer.close();
    },
  };
}

describe("session-capture / captureSessionFromCdp", () => {
  it("captures cookies and storage from a mock authenticated Chrome", async () => {
    const mock = await startMockCdp({
      pages: [
        { id: "1", title: "Dashboard | Claude", url: "https://console.anthropic.com/dashboard" },
        { id: "2", title: "Railway", url: "https://railway.app/dashboard" },
      ],
      cookies: [
        { name: "session_token", value: "abc123", domain: ".anthropic.com", path: "/", httpOnly: true, secure: true, sameSite: "lax", expires: 1893456000 },
        { name: "railway_sid", value: "xyz789", domain: ".railway.app", path: "/", secure: true, sameSite: "strict", expires: 1893456000 },
      ],
      storage: [
        { url: "https://console.anthropic.com/dashboard", localStorage: { theme: "dark", user_pref: "compact" }, sessionStorage: { flash_msg: "Welcome" } },
        { url: "https://railway.app/dashboard", localStorage: { project: "nexus" } },
      ],
    });

    try {
      const state = await captureSessionFromCdp({ port: mock.port });
      expect(state.version).toBe("1.0.0");
      expect(state.cookies).toHaveLength(2);
      expect(state.cookies[0]?.name).toBe("session_token");
      expect(state.cookies[0]?.sameSite).toBe("lax");
      expect(state.origins).toBeDefined();
      expect(state.origins!.length).toBeGreaterThanOrEqual(1);
    } finally {
      mock.close();
    }
  });

  it("filters pages by urlPatterns", async () => {
    const mock = await startMockCdp({
      pages: [
        { id: "1", title: "Anthropic", url: "https://console.anthropic.com/dashboard" },
        { id: "2", title: "Railway", url: "https://railway.app/dashboard" },
      ],
      cookies: [
        { name: "a", value: "1", domain: ".anthropic.com" },
        { name: "r", value: "2", domain: ".railway.app" },
      ],
      storage: [],
    });

    try {
      const state = await captureSessionFromCdp({ port: mock.port, urlPatterns: ["anthropic.com"] });
      expect(state.cookies).toHaveLength(2); // cookies are browser-wide, not filtered by page
    } finally {
      mock.close();
    }
  });

  it("throws when CDP is not reachable", async () => {
    await expect(captureSessionFromCdp({ port: 1, host: "127.0.0.1" })).rejects.toThrow(/not reachable/);
  });
});