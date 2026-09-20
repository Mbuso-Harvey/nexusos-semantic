/**
 * CLI tests — the `awg` entry point. We don't spawn the real CLI as a
 * subprocess (that's covered by the MCP stdio test); instead we exercise
 * the same building blocks (Crawler, GraphStore, GraphServer) the CLI
 * uses, plus a smoke test that the package's `bin` field is wired.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Graph } from "../../src/graph/graph.js";
import { GraphStore } from "../../src/store/store.js";
import { GraphServer, GraphClient } from "../../src/server/index.js";
import packageJson from "../../package.json" with { type: "json" };

describe("awg CLI", () => {
  it("exposes a bin entry in package.json", () => {
    expect(packageJson.bin).toBeDefined();
    // R6: bins point at the compiled entry point (dist), not TypeScript
    // source — a published package cannot execute .ts via the bin shim.
    expect(packageJson.bin.awg).toBe("dist/src/cli/awg.js");
    expect(packageJson.bin.nexus).toBe("dist/src/cli/awg.js");
    expect((packageJson as unknown as Record<string, unknown>).private).toBeUndefined();
  });

  it("exposes an `awg` script in package.json", () => {
    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts.awg).toContain("src/cli/awg.ts");
    expect(packageJson.scripts.nexus).toContain("src/cli/awg.ts");
  });

  describe("query subcommand — in-process dispatch", () => {
    let g: Graph;
    let srv: GraphServer;
    let cli: GraphClient;
    let port = 0;

    beforeAll(async () => {
      g = new Graph();
      g.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "Example",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      g.upsertAx({
        id: "ax:root", type: "ax-node", pageId: "page:/", role: "region", name: "Example",
        nameSource: "aria-label",
        states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
        properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
        apgPattern: null, focusable: false, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
      });
      srv = new GraphServer(g);
      const addr = await srv.start(0);
      port = addr.port;
      cli = new GraphClient("127.0.0.1", port);
      await cli.connect();
    });

    afterAll(async () => {
      cli.close();
      await srv.stop();
    });

    it("round-trips a graph.query call through the wire", async () => {
      const res: any = await cli.call("graph.query", { select: "ax-node" });
      expect(res.hits.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("store roundtrip — what `crawl` and `demo` write to disk", () => {
    it("writes graph.json + sidecar + log to --out", async () => {
      const outDir = mkdtempSync(join(tmpdir(), "awg-cli-"));
      const g = new Graph();
      g.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "T",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:r", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      const store = new GraphStore(outDir);
      await store.save(g, {
        rootUrl: "https://example.com/",
        startedAt: "2026-08-29T00:00:00Z",
        finishedAt: "2026-08-29T00:00:01Z",
        browser: { engine: "firefox", version: "154" },
      });
      expect(existsSync(store.graphPath)).toBe(true);
      expect(existsSync(store.metaPath)).toBe(true);
      const graph = JSON.parse(readFileSync(store.graphPath, "utf8"));
      expect(graph.version).toBe("1.0.0");
      // The log file is only created when appendLog is called.
      await store.appendLog("[awg] test log line\n");
      expect(existsSync(store.logPath)).toBe(true);
    });
  describe("doctor subcommand", () => {
    it("reports system and substrate health checklist via --json", async () => {
      const { execSync } = await import("node:child_process");
      const out = execSync("npx tsx src/cli/awg.ts doctor --json", { encoding: "utf8" });
      const res = JSON.parse(out);
      expect(res.ok).toBe(true);
      expect(Array.isArray(res.checks)).toBe(true);
      const names = res.checks.map((c: any) => c.name);
      expect(names).toContain("Node.js Runtime");
      expect(names).toContain("Storage & Workspace");
      const nodeCheck = res.checks.find((c: any) => c.name === "Node.js Runtime");
      expect(nodeCheck.status).toBe("ok");
    });
  });

  describe("inspect subcommand — diagnostics reporting", () => {
    it("reports health score, telemetry, and actionable recommendations", async () => {
      const { execSync } = await import("node:child_process");
      const outDir = mkdtempSync(join(tmpdir(), "awg-cli-inspect-"));
      const g = new Graph();
      g.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "Inspect Target",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:btn", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      // Add an unlabeled button to test health score deduction
      g.upsertAx({
        id: "ax:btn", type: "ax-node", pageId: "page:/", role: "button", name: "",
        nameSource: "contents",
        states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
        properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
        apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
      });
      g.recordExtractorFailure("page:/", "visual", "Computed style timeout");
      g.recordExtractionWarning("page:/", { tag: "bad-custom-element", elementId: "el-42", error: "Failed parsing shadow DOM" });

      const store = new GraphStore(outDir);
      await store.save(g, {
        rootUrl: "https://example.com/",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        browser: { engine: "firefox", version: "154" },
      });

      const out = execSync(`npx tsx src/cli/awg.ts inspect --graph "${outDir}" --diagnostics --json`, { encoding: "utf8" });
      const res = JSON.parse(out);
      expect(res.graphDir).toContain("awg-cli-inspect-");
      expect(res.summary.pagesLoaded).toBe(1);
      expect(res.summary.axNodesTotal).toBe(1);
      // Health score: 100 - 10 (extractorFailure) - 2 (extractionWarning) - 1 (unlabeled button) = 87
      expect(res.summary.healthScorePercent).toBe(87);
      expect(res.extractorFailures.length).toBe(1);
      expect(res.extractorFailures[0].extractor).toBe("visual");
      expect(res.extractionWarnings.length).toBe(1);
      expect(res.unlabeledInteractive.length).toBe(1);
      expect(res.recommendations.length).toBeGreaterThanOrEqual(1);

      // Also verify human-readable text output runs without error
      const textOut = execSync(`npx tsx src/cli/awg.ts inspect --graph "${outDir}" --diagnostics`, { encoding: "utf8" });
      expect(textOut).toContain("Agent Web Graph — Inspection & Diagnostics Report");
      expect(textOut).toContain("Overall Health:");
      expect(textOut).toContain("Extractor Failures:  1");
    });

    // ED-08 §8 (audit finding F7): an empty graph must fail loudly. Before
    // this, a crawl whose structural walker produced nothing exited 0.
    it("--fail-on-diagnostics exits 1 when a page produced no accessibility tree", async () => {
      const { execSync } = await import("node:child_process");
      const outDir = mkdtempSync(join(tmpdir(), "awg-cli-gate-"));
      const g = new Graph();
      g.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "Silently Empty",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:root", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      // Deliberately NO ax nodes: the page loaded, the extraction produced nothing.
      const store = new GraphStore(outDir);
      await store.save(g, {
        rootUrl: "https://example.com/",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        browser: { engine: "firefox", version: "154" },
      });

      // Reporting stays non-fatal without the gate.
      const out = execSync(`npx tsx src/cli/awg.ts inspect --graph "${outDir}" --json`, { encoding: "utf8" });
      const res = JSON.parse(out);
      expect(res.summary.pagesWithNoAxTree).toBe(1);
      expect(res.pagesWithNoAxTree.length).toBe(1);
      expect(res.recommendations.some((r: string) => /NO accessibility tree/.test(r))).toBe(true);

      // The gate makes it fatal.
      let status: number | undefined;
      let stderr = "";
      try {
        execSync(`npx tsx src/cli/awg.ts inspect --graph "${outDir}" --fail-on-diagnostics`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e: any) {
        status = e.status;
        stderr = String(e.stderr ?? "");
      }
      expect(status).toBe(1);
      expect(stderr).toContain("--fail-on-diagnostics");
      expect(stderr).toMatch(/no accessibility tree/);
    });

    it("--fail-on-diagnostics tolerates extractor failures up to --max-extractor-failures", async () => {
      const { execSync } = await import("node:child_process");
      const outDir = mkdtempSync(join(tmpdir(), "awg-cli-gate-tol-"));
      const g = new Graph();
      g.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "Healthy",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:btn", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      g.upsertAx({
        id: "ax:btn", type: "ax-node", pageId: "page:/", role: "button", name: "Sign up",
        nameSource: "contents",
        states: { expanded: null, disabled: null, pressed: null, selected: null, checked: null, busy: null, open: null, current: null },
        properties: { controls: [], describedBy: [], labelledBy: [], level: null, live: null, orientation: null, posInSet: null, setSize: null, valueNow: null, valueMin: null, valueMax: null, valueText: null },
        apgPattern: null, focusable: true, visibility: "visible", inPageDomOrder: 0, parentAxId: null, provenance: "aria:t",
      });
      g.recordExtractorFailure("page:/", "visual", "Computed style timeout");
      const store = new GraphStore(outDir);
      await store.save(g, {
        rootUrl: "https://example.com/",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        browser: { engine: "firefox", version: "154" },
      });

      // Default threshold 0 => 1 failure is fatal.
      let strictStatus: number | undefined;
      try {
        execSync(`npx tsx src/cli/awg.ts inspect --graph "${outDir}" --fail-on-diagnostics`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e: any) { strictStatus = e.status; }
      expect(strictStatus).toBe(1);

      // Raised threshold => the same graph passes.
      const ok = execSync(
        `npx tsx src/cli/awg.ts inspect --graph "${outDir}" --fail-on-diagnostics --max-extractor-failures 1 --json`,
        { encoding: "utf8" },
      );
      const res = JSON.parse(ok);
      expect(res.summary.pagesWithNoAxTree).toBe(0);
      expect(res.extractorFailures.length).toBe(1);
    });
  });
  describe("diff subcommand — visual regression diffing", () => {
    it("compares two saved graphs and produces visual regression report via --json", async () => {
      const { execSync } = await import("node:child_process");
      const baseDir = mkdtempSync(join(tmpdir(), "awg-diff-base-"));
      const candDir = mkdtempSync(join(tmpdir(), "awg-diff-cand-"));

      const gBase = new Graph();
      gBase.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "Test Page",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:btn", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      gBase.upsertVisual({
        id: "vis:btn", type: "visual-node", axId: "ax:btn", pageId: "page:/",
        rect: { x: 100, y: 100, w: 200, h: 50 },
        computedStyle: { color: "#ffffff", backgroundColor: "#0066cc" },
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:script.evaluate",
      });

      const gCand = new Graph();
      gCand.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "Test Page",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:btn", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      // Shifted by 80px down
      gCand.upsertVisual({
        id: "vis:btn", type: "visual-node", axId: "ax:btn", pageId: "page:/",
        rect: { x: 100, y: 180, w: 200, h: 50 },
        computedStyle: { color: "#ffffff", backgroundColor: "#ff0000" },
        designTokenRefs: [],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        provenance: "bidi:script.evaluate",
      });

      const storeBase = new GraphStore(baseDir);
      await storeBase.save(gBase, {
        rootUrl: "https://example.com/", startedAt: "t0", finishedAt: "t1", browser: { engine: "firefox", version: "154" },
      });
      const storeCand = new GraphStore(candDir);
      await storeCand.save(gCand, {
        rootUrl: "https://example.com/", startedAt: "t0", finishedAt: "t1", browser: { engine: "firefox", version: "154" },
      });

      const out = execSync(`npx tsx src/cli/awg.ts diff "${baseDir}" "${candDir}" --page "page:/" --json`, { encoding: "utf8" });
      const report = JSON.parse(out);
      expect(report.pageId).toBe("page:/");
      expect(report.regressedNodesCount).toBeGreaterThan(0);
      expect(report.cumulativeLayoutShift).toBeGreaterThan(0);
      expect(report.nodeDiffs.length).toBeGreaterThanOrEqual(1);

      // Also verify human-readable output
      const textOut = execSync(`npx tsx src/cli/awg.ts diff "${baseDir}" "${candDir}" --page "page:/"`, { encoding: "utf8" });
      expect(textOut).toContain("Visual Regression Diff Report");
      expect(textOut).toContain("Cumulative Layout Shift");
    });
  });

  describe("tokens subcommand — DTCG export and linting", () => {
    it("exports standard DTCG token bundle and lints drifts", async () => {
      const { execSync } = await import("node:child_process");
      const outDir = mkdtempSync(join(tmpdir(), "awg-tokens-"));
      const exportFile = join(outDir, "exported-dtcg.json");

      const g = new Graph();
      g.upsertPage({
        id: "page:/", type: "page", url: "https://example.com/", title: "Test Page",
        discoveredVia: ["seed"], loadStatus: "complete",
        axTreeRef: { rootAxId: "ax:btn", provenance: "aria:t" },
        viewport: { w: 1280, h: 800, dpr: 1 }, tokensOverride: null, screenshotRef: null,
        canonicalUrl: "https://example.com/", crawledAt: "t", parentPageId: null,
      });
      g.upsertToken("color.brand.primary", {
        $type: "color",
        $value: "#0066cc",
        $description: "Brand primary blue",
      });
      g.upsertToken("spacing.md", {
        $type: "dimension",
        $value: "16px",
        $description: "Medium spacing",
      });
      g.upsertVisual({
        id: "vis:btn", type: "visual-node", axId: "ax:btn", pageId: "page:/",
        rect: { x: 100, y: 100, w: 200, h: 50 },
        computedStyle: { color: "#ffffff", backgroundColor: "#0066cc", padding: "15px" },
        designTokenRefs: ["color.brand.primary"],
        tethers: { parent: null, children: [], siblingsBefore: [], siblingsAfter: [], anchors: [] },
        tokenDrifts: [
          {
            axId: "ax:btn",
            pageId: "page:/",
            property: "padding",
            actualValue: "15px",
            suggestedToken: "spacing.md",
            suggestedValue: "16px",
            driftDelta: 1,
            severity: "low",
            message: "1px off",
          },
        ],
        provenance: "bidi:script.evaluate",
      });

      const store = new GraphStore(outDir);
      await store.save(g, {
        rootUrl: "https://example.com/", startedAt: "t0", finishedAt: "t1", browser: { engine: "firefox", version: "154" },
      });

      // Export DTCG tokens
      execSync(`npx tsx src/cli/awg.ts tokens --graph "${outDir}" --export-dtcg "${exportFile}"`, { encoding: "utf8" });
      expect(existsSync(exportFile)).toBe(true);
      const bundle = JSON.parse(readFileSync(exportFile, "utf8"));
      expect(bundle.version).toBe("1.0.0");
      expect(bundle.tokens).toBeDefined();
      expect(bundle.metadata.totalTokens).toBe(2);

      // Lint drifts
      const lintOut = execSync(`npx tsx src/cli/awg.ts tokens --graph "${outDir}" --lint --json`, { encoding: "utf8" });
      const drifts = JSON.parse(lintOut);
      expect(drifts.length).toBe(1);
      expect(drifts[0].property).toBe("padding");
      expect(drifts[0].suggestedToken).toBe("spacing.md");
    });
  });


  });
});
