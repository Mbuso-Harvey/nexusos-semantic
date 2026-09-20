/**
 * GitHub eval harness test — exercises the 5 tasks against a populated GitHub crawl fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGitHubGraph } from "./fixtures/github-graph.js";
import { runEval } from "../../src/eval/runner.js";
import { GraphStore } from "../../src/store/store.js";
import { task1 } from "../../src/eval/tasks/task1-tabs.js";
import { task2 } from "../../src/eval/tasks/task2-cta.js";
import { task3 } from "../../src/eval/tasks/task3-capabilities.js";
import { task5 } from "../../src/eval/tasks/task5-sticky-headers.js";

let graphDir = "";

beforeEach(async () => {
  graphDir = await mkdtemp(join(tmpdir(), "awg-github-eval-"));
});

afterEach(async () => {
  await rm(graphDir, { recursive: true, force: true });
});

describe("GitHub Eval Fixture & Tasks", () => {
  it("evaluates task1 (tabs) on GitHub repository graph", async () => {
    const graph = buildGitHubGraph();
    const res = await task1({ graph, target: "github" });
    expect(res.ok).toBe(true);
    const rows = res.data as Array<{ tabName: string; panelAxId: string }>;
    expect(rows).toHaveLength(8);
    const tabNames = rows.map((r) => r.tabName);
    expect(tabNames).toContain("Code");
    expect(tabNames).toContain("Issues");
    expect(tabNames).toContain("Pull requests");
    expect(tabNames).toContain("Actions");
  });

  it("evaluates task2 (cta) finding the primary GitHub signup CTA", async () => {
    const graph = buildGitHubGraph();
    const res = await task2({ graph, target: "github" });
    expect(res.ok).toBe(true);
    const row = res.data as { name: string; designTokenRefs: string[] };
    expect(row.name).toBe("Sign up for GitHub");
    expect(row.designTokenRefs).toContain("color.btn.primary.bg");
  });

  it("evaluates task3 (capabilities) discovering create_issue and create_pull_request", async () => {
    const graph = buildGitHubGraph();
    const res = await task3({ graph, target: "github" });
    expect(res.ok).toBe(true);
    const rows = res.data as Array<{ name: string; security: string }>;
    expect(rows).toHaveLength(2);
    const capNames = rows.map((r) => r.name).sort();
    expect(capNames).toEqual(["create_issue", "create_pull_request"]);
  });

  it("evaluates task5 (sticky headers) discovering the global GitHub topbar", async () => {
    const graph = buildGitHubGraph();
    const res = await task5({ graph, target: "github" });
    expect(res.ok).toBe(true);
    const rows = res.data as Array<{ role: string; name: string; bgColor: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Global");
    expect(rows[0]?.role).toBe("navigation");
    expect(rows[0]?.bgColor).toBe("rgb(36, 41, 47)");
  });

  it("runs the full eval runner with the populated github fixture achieving 4 passed tasks", async () => {
    const graph = buildGitHubGraph();
    const store = new GraphStore(graphDir);
    await store.save(graph, {
      rootUrl: "https://github.com/torvalds/linux/",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      browser: { engine: "firefox", version: "154" },
    });

    const fixturePath = resolve("src/eval/fixtures/github-populated-tasks.json");
    const trace = await runEval({
      graphDir,
      target: "github",
      fixturePath,
    });

    expect(trace.version).toBe("1.0.0");
    expect(trace.target).toBe("github");
    expect(trace.summary.failed).toBe(0);
    expect(trace.summary.passed).toBe(4);
    expect(trace.summary.skipped).toBe(1); // task 4 requires live Page
    for (const t of trace.tasks) {
      expect(t.withinBudget).toBe(true);
    }
  });
});
