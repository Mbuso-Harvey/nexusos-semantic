/**
 * Runner tests — Stage 17.
 *
 * Exercises the trace writer, fixture comparator, latency budgets, and
 * "no Page" failure path against a canned in-memory Graph. 6 tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runEval, type TraceFile } from "../../src/eval/runner.js";
import { buildCannedGraph } from "./fixtures/canned-graph.js";
import { MockPage } from "./fixtures/MockPage.js";

let graphDir: string;

beforeEach(async () => {
  graphDir = join(tmpdir(), `awg-eval-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(graphDir, { recursive: true });
});

afterEach(async () => {
  await rm(graphDir, { recursive: true, force: true });
});

describe("eval runner", () => {
  it("runs all 5 tasks against the canned graph and writes a valid trace file", async () => {
    // Persist the canned graph to disk so the runner's loadGraph() works.
    const { GraphStore } = await import("../../src/store/store.js");
    const graph = buildCannedGraph();
    const store = new GraphStore(graphDir);
    await store.save(graph, {
      rootUrl: "http://example.test/",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      browser: { engine: "firefox", version: "test" },
    });

    const trace = await runEval({
      graphDir,
      target: "synthetic",
      // Use the bundled synthetic fixture; runner auto-loads it.
    });

    // Trace shape.
    expect(trace.version).toBe("1.0.0");
    expect(trace.target).toBe("synthetic");
    expect(trace.graphDir).toBe(graphDir);
    expect(trace.tasks).toHaveLength(5);

    // The bundled synthetic-tasks.json fixture has concrete assertions for
    // tasks 1, 2, 3 (matching the canned graph's actual data shape: 3 tabs,
    // 1 button with color.accent, 1 capability matching the /(create|update)/i
    // regex) and `null` placeholders for tasks 4, 5 (which need a live Page
    // / dedup logic we don't run in unit tests). What we care about: the
    // trace is well-formed and latency reporting works.
    expect(trace.summary.failed).toBe(0);
    expect(trace.summary.passed).toBe(3);
    expect(trace.summary.skipped).toBe(2);

    for (const t of trace.tasks) {
      expect(t.withinBudget).toBe(true);
      expect(typeof t.durationMs).toBe("number");
    }

    // Trace file is well-formed on disk.
    const raw = await readFile(join(graphDir, "demo.trace.json"), "utf8");
    const parsed = JSON.parse(raw) as TraceFile;
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.tasks).toHaveLength(5);
  });

  it("summary overBudget counts tasks that exceed their budget", async () => {
    // Use a fixture whose task has an aggressive threshold (1ms) so we trip
    // the over-budget counter. The runner's real perf is sub-ms for canned
    // graph, but loop overhead + JSON parse makes 1ms reliable to exceed.
    const { GraphStore } = await import("../../src/store/store.js");
    const graph = buildCannedGraph();
    const store = new GraphStore(graphDir);
    await store.save(graph, {
      rootUrl: "http://example.test/",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      browser: { engine: "firefox", version: "test" },
    });

    const trace = await runEval({
      graphDir,
      target: "synthetic",
      thresholds: { "1-tabs": 0 },  // force over-budget on the first task
    });
    // At least one overBudget.
    expect(trace.summary.overBudget).toBeGreaterThanOrEqual(1);
    // Over-budget does NOT mark the task as failed.
    const overTask = trace.tasks.find((t) => !t.withinBudget);
    expect(overTask).toBeDefined();
    expect(overTask!.skipped || overTask!.pass).toBe(true);
  });

  it("treats assert.present:null in the github-tasks.json fixture as 'skipped'", async () => {
    const { GraphStore } = await import("../../src/store/store.js");
    const graph = buildCannedGraph();
    const store = new GraphStore(graphDir);
    await store.save(graph, {
      rootUrl: "http://example.test/",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      browser: { engine: "firefox", version: "test" },
    });

    // Pin to the github target so the bundled github-tasks.json (all
    // assert.present: null placeholders) is loaded.
    const trace = await runEval({ graphDir, target: "github" });
    expect(trace.summary.skipped).toBe(5);
    expect(trace.summary.failed).toBe(0);
    expect(trace.summary.passed).toBe(0);
    for (const t of trace.tasks) {
      expect(t.skipped).toBe(true);
      expect(t.diff).toBeUndefined();
    }
  });

  it("task 4 returns pass:false with error when no Page is provided", async () => {
    const { GraphStore } = await import("../../src/store/store.js");
    const graph = buildCannedGraph();
    const store = new GraphStore(graphDir);
    await store.save(graph, {
      rootUrl: "http://example.test/",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      browser: { engine: "firefox", version: "test" },
    });
    // Force a known-shape fixture so we don't rely on a pass/skip on task 4.
    const fixture = {
      "4-toggle-theme": { assert: { present: { flipped: true, before: "light", after: "dark" } } },
    };
    const fixturePath = join(graphDir, "fixture.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const trace = await runEval({
      graphDir,
      target: "synthetic",
      fixturePath,
      // no page
    });
    const t4 = trace.tasks.find((t) => t.id === "4-toggle-theme")!;
    expect(t4).toBeDefined();
    expect(t4.pass).toBe(false);
    expect(t4.skipped).toBe(false);
    expect(t4.output.ok).toBe(false);
    expect(t4.output.error).toMatch(/live Page/i);
  });

  it("task 4 with a MockPage reports flipped=true and matches the fixture", async () => {
    const { GraphStore } = await import("../../src/store/store.js");
    const graph = buildCannedGraph();
    const store = new GraphStore(graphDir);
    await store.save(graph, {
      rootUrl: "http://example.test/",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      browser: { engine: "firefox", version: "test" },
    });
    const fixture = {
      "4-toggle-theme": {
        assert: { present: { axId: "ax:theme-toggle", before: "light", after: "dark", flipped: true } },
      },
    };
    const fixturePath = join(graphDir, "fixture.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const page = new MockPage();
    const trace = await runEval({ graphDir, target: "synthetic", fixturePath, page });
    const t4 = trace.tasks.find((t) => t.id === "4-toggle-theme")!;
    expect(t4.pass).toBe(true);
    expect(t4.skipped).toBe(false);
    expect(t4.diff).toBeUndefined();
    // MockPage should have recorded the evaluate/callFunction calls.
    const kinds = page.calls.map((c) => c.kind);
    expect(kinds).toEqual(["evaluate", "callFunction", "evaluate"]);
  });

  it("mismatch between fixture and actual is reported as pass:false with a diff path", async () => {
    const { GraphStore } = await import("../../src/store/store.js");
    const graph = buildCannedGraph();
    const store = new GraphStore(graphDir);
    await store.save(graph, {
      rootUrl: "http://example.test/",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      browser: { engine: "firefox", version: "test" },
    });
    // Hand a fixture that mismatches the canned graph's actual task 1
    // output — fixture says { tabName: "Phantom" } which doesn't exist.
    const fixture = {
      "1-tabs": { assert: { present: [{ tabName: "Phantom", panelAxId: "ax:phantom", panelName: "Phantom panel" }] } },
    };
    const fixturePath = join(graphDir, "fixture.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const trace = await runEval({ graphDir, target: "synthetic", fixturePath });
    const t1 = trace.tasks.find((t) => t.id === "1-tabs")!;
    expect(t1.pass).toBe(false);
    expect(t1.skipped).toBe(false);
    expect(t1.diff).toBeDefined();
    // The diff is a structural mismatch — accept any non-null value.
    expect(t1.diff).not.toBeNull();
  });
});
