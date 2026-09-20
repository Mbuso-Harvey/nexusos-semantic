/**
 * R1 + R2 gate tests — substrate loading must fail closed, and a loaded
 * substrate must carry provable provenance (crawl block + computed hash).
 *
 * Without these fixes:
 *  - `serve` with a missing graph.json silently served an empty graph
 *    (`new Graph()`) — the root cause of demo artifacts being served as live.
 *  - `loadFromDocument` discarded the `crawl` block, so no agent could ever
 *    see rootUrl / crawl time / browser version.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Graph } from "../../src/graph/graph.js";
import {
  GraphStore,
  loadFromDocument,
  loadSubstrate,
  assertGraphHashBinding,
  computeGraphHash,
  SubstrateLoadError,
} from "../../src/store/index.js";
import type { GraphDocument } from "../../src/graph/types.js";

function seedGraph(): Graph {
  const g = new Graph();
  g.upsertPage({
    id: "page:/", type: "page", url: "https://example.com/", title: "Example",
    discoveredVia: ["seed"], loadStatus: "complete",
    axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
    viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
    canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
  });
  return g;
}

describe("substrate provenance + fail-closed load (R1/R2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "awg-provenance-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("save → load round trip restores the crawl block as provenance", async () => {
    const store = new GraphStore(dir);
    const crawlInfo = {
      rootUrl: "https://app.example.com/",
      startedAt: "2026-09-14T10:00:00.000Z",
      finishedAt: "2026-09-14T10:01:00.000Z",
      browser: { engine: "firefox", version: "154" } as const,
    };
    await store.save(seedGraph(), crawlInfo);

    const { graph, provenance } = await loadSubstrate(dir);
    expect(graph).toBeInstanceOf(Graph);
    expect(provenance.crawl).toEqual({ ...crawlInfo, pages: 1, tokens: 0 });
    expect(provenance.outputDir).toBe(dir);
    expect(provenance.graphPath).toBe(join(dir, "graph.json"));
    expect(provenance.buildVersion).toBeTruthy();
  });

  it("computes graphHash from the raw graph.json bytes", async () => {
    const store = new GraphStore(dir);
    await store.save(seedGraph(), {
      rootUrl: "https://app.example.com/",
      startedAt: "2026-09-14T10:00:00.000Z",
      finishedAt: "2026-09-14T10:01:00.000Z",
      browser: { engine: "firefox", version: "154" },
    });
    const { provenance } = await loadSubstrate(dir);
    const raw = readFileSync(join(dir, "graph.json"), "utf8");
    expect(provenance.graphHash).toBe(computeGraphHash(raw));
    expect(provenance.graphHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loadSubstrate throws SUBSTRATE_MISSING for a directory without graph.json (fail closed)", async () => {
    mkdirSync(join(dir, "empty"), { recursive: true });
    await expect(loadSubstrate(join(dir, "empty"))).rejects.toMatchObject({
      name: "SubstrateLoadError",
      code: "SUBSTRATE_MISSING",
    });
    await expect(loadSubstrate(join(dir, "empty"))).rejects.toThrow(/nexus crawl/);
  });

  it("loadSubstrate throws SUBSTRATE_INVALID for a foreign graph.json (e.g. a Cosmos node array)", async () => {
    mkdirSync(dir, { recursive: true });
    // Exactly the shape that used to crash `serve`: a non-Nexus graph.json.
    writeFileSync(join(dir, "graph.json"), JSON.stringify([{ id: "cosmos:node", kind: "event" }]));
    await expect(loadSubstrate(dir)).rejects.toMatchObject({
      name: "SubstrateLoadError",
      code: "SUBSTRATE_INVALID",
    });
  });

  it("loadFromDocument rejects unsupported document versions with a typed error", () => {
    const doc = { version: "9.9.9" } as unknown as GraphDocument;
    expect(() => loadFromDocument(doc)).toThrow(SubstrateLoadError);
    expect(() => loadFromDocument(doc)).toThrow(/unsupported graph document version/);
  });

  it("assertGraphHashBinding refuses a mismatched operator-asserted hash", async () => {
    const store = new GraphStore(dir);
    await store.save(seedGraph(), {
      rootUrl: "https://app.example.com/",
      startedAt: "2026-09-14T10:00:00.000Z",
      finishedAt: "2026-09-14T10:01:00.000Z",
      browser: { engine: "firefox", version: "154" },
    });
    const { provenance } = await loadSubstrate(dir);
    const real = provenance.graphHash!;

    // Matching (with or without the sha256: prefix) binds cleanly.
    expect(() => assertGraphHashBinding(provenance, real)).not.toThrow();
    expect(() => assertGraphHashBinding(provenance, `sha256:${real}`)).not.toThrow();

    // Mismatched claim → refuse (§2.4: no silent substitutions).
    const fake = createHash("sha256").update("not-the-graph").digest("hex");
    expect(() => assertGraphHashBinding(provenance, fake)).toThrow(SubstrateLoadError);
    try {
      assertGraphHashBinding(provenance, fake);
      expect.unreachable();
    } catch (err) {
      expect((err as SubstrateLoadError).code).toBe("SUBSTRATE_HASH_MISMATCH");
      expect((err as SubstrateLoadError).message).toContain(real.slice(0, 8));
    }

    // Claimed hash but in-memory substrate → refuse (nothing to verify against).
    expect(() => assertGraphHashBinding(null, real)).toThrow(SubstrateLoadError);

    // No claim → no-op (binding happens to the computed hash instead).
    expect(() => assertGraphHashBinding(provenance, undefined)).not.toThrow();
  });
});
