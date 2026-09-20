/**
 * BiDi transport — wraps the raw WebSocket with request/response correlation,
 * auto-reconnect, and a single in-flight event stream.
 *
 * Design notes:
 * - One BiDiClient = one WebSocket = one BiDi session.
 * - send<T>() returns the result payload; throws on error response.
 * - Events flow through a single AsyncIterator; subscribers attach via .events().
 * - No automatic reconnection in v1 — caller creates a new client per session.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type BiDiEvent =
  | { method: string; params: any }
  | { method: string; params: any; id: number };

export type BiDiResult = any;
export type BiDiError = { error: string; message: string; stacktrace?: string };

type Pending = {
  resolve: (r: BiDiResult) => void;
  reject: (e: Error) => void;
  method: string;
};

export class BiDiTransport {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, Pending>();
  private emitter = new EventEmitter();
  private closed = false;

  constructor(
    public readonly url: string,
    opts: { origin?: string } = {},
  ) {
    const headers = { origin: opts.origin ?? "http://127.0.0.1:9222" };
    this.ws = new WebSocket(url, { headers });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", (code, reason) => this.onClose(code, reason.toString()));
    this.ws.on("error", (e) => this.onError(e));
  }

  /** Resolves when the WS handshake completes. */
  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (e: Error) => { cleanup(); reject(e); };
      const cleanup = () => {
        this.ws.off("open", onOpen);
        this.ws.off("error", onError);
      };
      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
    });
  }

  /** Send a BiDi command and await its result. Throws on error response. */
  async send<T = BiDiResult>(method: string, params: Record<string, any> = {}): Promise<T> {
    if (this.closed) throw new Error(`BiDi: cannot send ${method}; transport closed`);
    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as any, reject, method });
      this.ws.send(payload);
    });
  }

  /** Subscribe to BiDi events. Returns an unsubscribe function. */
  events(handler: (e: BiDiEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }

  private onMessage(text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg?.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return; // late response after timeout
      this.pending.delete(msg.id);
      if (msg.type === "success") p.resolve(msg.result);
      else p.reject(new BiDiRpcError(msg.error ?? "unknown", msg.message ?? "", msg.stacktrace, p.method));
    } else if (typeof msg?.method === "string") {
      this.emitter.emit("event", msg);
    }
  }

  private onClose(code: number, reason: string): void {
    this.closed = true;
    const err = new Error(`BiDi WS closed: ${code} ${reason}`);
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onError(e: Error): void {
    // Don't double-reject; onClose will follow.
    if (!this.closed) {
      // surface the error so callers awaiting open() can react
      this.emitter.emit("error", e);
    }
  }
}

export class BiDiRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly stacktrace: string | undefined,
    public readonly method: string,
  ) {
    super(`${method}: ${code} — ${message}`);
    this.name = "BiDiRpcError";
  }
}
