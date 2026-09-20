/**
 * Task 4 tests — click the custom invoker `--toggle-theme` and verify the
 * theme var flips. Uses the MockPage to keep the test hermetic.
 */
import { describe, it, expect } from "vitest";
import { buildCannedGraph } from "./fixtures/canned-graph.js";
import { MockPage } from "./fixtures/MockPage.js";
import { task4 } from "../../src/eval/tasks/task4-click-and-verify.js";

describe("task4 — click + verify theme toggle", () => {
  it("returns ok:false with a clear error when no Page is provided", async () => {
    const graph = buildCannedGraph();
    const result = await task4({ graph, target: "synthetic" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/live Page/i);
  });

  it("returns ok:false for github target (placeholder)", async () => {
    const graph = buildCannedGraph();
    const page = new MockPage();
    const result = await task4({ graph, page, target: "github" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/github.*not yet implemented/i);
  });

  it("flips before/after and reports the toggle button's axId", async () => {
    const graph = buildCannedGraph();
    const page = new MockPage();
    page.theme = "light";
    const result = await task4({ graph, page, target: "synthetic" });
    expect(result.ok).toBe(true);
    const data = result.data as { axId: string; before: string; after: string; flipped: boolean };
    expect(data.axId).toBe("ax:theme-toggle");
    expect(data.before).toBe("light");
    expect(data.after).toBe("dark");
    expect(data.flipped).toBe(true);
  });

  it("records exactly 2 evaluate + 1 callFunction calls on the mock page", async () => {
    const graph = buildCannedGraph();
    const page = new MockPage();
    await task4({ graph, page, target: "synthetic" });
    const evals = page.calls.filter((c) => c.kind === "evaluate");
    const clicks = page.calls.filter((c) => c.kind === "callFunction");
    expect(evals).toHaveLength(2);
    expect(clicks).toHaveLength(1);
    // The click expression should be a bare arrow (per the walker-fn contract).
    expect(clicks[0]!.expression.trim().startsWith("() =>")).toBe(true);
  });
});
