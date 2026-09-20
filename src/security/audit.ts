/**
 * Nexus Audit Streaming — immutable, append-only security event logging.
 *
 * Every posture change and operation execution flows to the audit stream.
 * The stream is append-only (no modification, no deletion), timestamped,
 * hash-chained (each event references the previous hash), and can be
 * streamed to external SIEMs (Splunk, Datadog, Elastic).
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent } from "./posture.js";

export interface EnrichedAuditEvent extends AuditEvent {
  sequence: number;
  prevHash: string;
  hash: string;
}

export interface AuditStreamOptions {
  dir: string;
  streamId: string;
  siemEndpoint?: string;
  siemToken?: string;
}

export class AuditStream {
  private streamId: string;
  private dir: string;
  private sequence = 0;
  private lastHash = "GENESIS";
  private siemEndpoint?: string;
  private siemToken?: string;
  private buffer: EnrichedAuditEvent[] = [];
  private flushIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: AuditStreamOptions) {
    this.streamId = opts.streamId;
    this.dir = opts.dir;
    this.siemEndpoint = opts.siemEndpoint;
    this.siemToken = opts.siemToken;
    this.flushIntervalMs = 5_000;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // A background flusher must never keep a one-shot process (e.g. the CLI)
    // alive; long-running servers stay up for their own reasons.
    this.timer.unref?.();
  }

  async record(event: AuditEvent): Promise<EnrichedAuditEvent> {
    this.sequence++;
    const enriched: EnrichedAuditEvent = {
      ...event,
      sequence: this.sequence,
      prevHash: this.lastHash,
      hash: "",
    };
    enriched.hash = this.computeHash(enriched);
    this.lastHash = enriched.hash;
    this.buffer.push(enriched);
    return enriched;
  }

  private computeHash(event: Omit<EnrichedAuditEvent, "hash">): string {
    return createHash("sha256").update(JSON.stringify({ ...event, hash: undefined })).digest("hex");
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const file = join(this.dir, `${this.streamId}.jsonl`);
    const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(file, lines, "utf8");
    if (this.siemEndpoint) await this.pushToSiem(batch);
  }

  private async pushToSiem(events: EnrichedAuditEvent[]): Promise<void> {
    try {
      await fetch(this.siemEndpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.siemToken ? { Authorization: `Bearer ${this.siemToken}` } : {}) },
        body: JSON.stringify({ streamId: this.streamId, events }),
      });
    } catch { /* best-effort */ }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  get currentSequence(): number { return this.sequence; }
  get currentHash(): string { return this.lastHash; }
}
