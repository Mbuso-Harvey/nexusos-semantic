/**
 * Eval runner — Stage 17.
 *
 * Loads a graph from disk, dispatches the 5 demo tasks, measures latency,
 * compares to a per-target fixture, and writes `demo.trace.json`.
 *
 * Fixture shape (synthetic-tasks.json / github-tasks.json):
 *   {
 *     "1-tabs":          { "assert": { "present": <expr> | null, ... } },
 *     "2-cta":           { ... },
 *     "3-capabilities":  { ... },
 *     "4-toggle-theme":  { ... },
 *     "5-sticky":        { ... }
 *   }
 *
 * When `assert.present` is `null` the task is reported as `skipped` (used
 * by the GitHub placeholder fixture until a real crawl populates expected
 * outputs). When the assertion is a non-null expression, the runner
 * structural-equality-compares against `task result.data`.
 *
 * Latency never affects correctness: a task that returns the right data
 * but exceeds its budget is reported `pass: true, withinBudget: false`.
 */
import { performance } from "node:perf_hooks";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Graph } from "../graph/graph.js";
import type { PageLike } from "./tasks/types.js";
import type { GraphDocument } from "../graph/types.js";
import { loadFromDocument } from "../store/store.js";

import { task1 } from "./tasks/task1-tabs.js";
import { task2 } from "./tasks/task2-cta.js";
import { task3 } from "./tasks/task3-capabilities.js";
import { task4 } from "./tasks/task4-click-and-verify.js";
import { task5 } from "./tasks/task5-sticky-headers.js";
import type { TaskFn, TaskResult } from "./tasks/types.js";

// ---- Task registry ----

export type TaskId = "1-tabs" | "2-cta" | "3-capabilities" | "4-toggle-theme" | "5-sticky";

const TASKS: Array<{ id: TaskId; fn: TaskFn }> = [
  { id: "1-tabs",          fn: task1 },
  { id: "2-cta",           fn: task2 },
  { id: "3-capabilities",  fn: task3 },
  { id: "4-toggle-theme",  fn: task4 },
  { id: "5-sticky",        fn: task5 },
];

export const DEFAULT_THRESHOLDS: Record<TaskId, number> = {
  "1-tabs":         500,
  "2-cta":          500,
  "3-capabilities": 500,
  "4-toggle-theme": 5000,
  "5-sticky":       500,
};

// ---- Trace shape ----

export interface TaskTrace {
  id: TaskId;
  timestamp: string;
  durationMs: number;
  output: TaskResult;
  budgetMs: number;
  withinBudget: boolean;
  pass: boolean;
  skipped: boolean;
  diff?: unknown;
}

export interface TraceFile {
  version: "1.0.0";
  target: "synthetic" | "github";
  graphDir: string;
  startedAt: string;
  finishedAt: string;
  tasks: TaskTrace[];
  summary: { passed: number; failed: number; skipped: number; overBudget: number };
}

// ---- Options ----

export interface RunnerOptions {
  graphDir: string;
  target: "synthetic" | "github";
  page?: PageLike;
  thresholds?: Partial<Record<TaskId, number>>;
  /** Override the default fixture path (mainly for tests). */
  fixturePath?: string;
}

// ---- Public entry point ----

export async function runEval(opts: RunnerOptions): Promise<TraceFile> {
  const startedAt = new Date().toISOString();

  const graph = await loadGraph(opts.graphDir);
  const fixture = await loadFixture(opts.target, opts.fixturePath);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };

  const ctx = { graph, page: opts.page, target: opts.target };
  const traces: TaskTrace[] = [];

  for (const { id, fn } of TASKS) {
    const ts = new Date().toISOString();
    const t0 = performance.now();
    let result: TaskResult;
    try {
      result = await fn(ctx);
    } catch (e) {
      result = { ok: false, data: null, error: String((e as Error).message) };
    }
    const durationMs = performance.now() - t0;
    const budgetMs = thresholds[id];

    const expected = fixture[id];
    const { pass, diff, skipped } = assertResult(expected, result);

    traces.push({
      id,
      timestamp: ts,
      durationMs,
      output: result,
      budgetMs,
      withinBudget: durationMs <= budgetMs,
      pass,
      skipped,
      diff,
    });
  }

  const finishedAt = new Date().toISOString();
  const trace: TraceFile = {
    version: "1.0.0",
    target: opts.target,
    graphDir: opts.graphDir,
    startedAt,
    finishedAt,
    tasks: traces,
    summary: {
      passed: traces.filter((t) => t.pass && !t.skipped).length,
      failed: traces.filter((t) => !t.pass && !t.skipped).length,
      skipped: traces.filter((t) => t.skipped).length,
      overBudget: traces.filter((t) => !t.withinBudget).length,
    },
  };

  await mkdir(opts.graphDir, { recursive: true });
  await writeFile(join(opts.graphDir, "demo.trace.json"), JSON.stringify(trace, null, 2), "utf8");
  return trace;
}

// ---- Helpers ----

async function loadGraph(graphDir: string): Promise<Graph> {
  const raw = await readFile(join(graphDir, "graph.json"), "utf8");
  const doc = JSON.parse(raw) as GraphDocument;
  return loadFromDocument(doc);
}

async function loadFixture(
  target: "synthetic" | "github",
  overridePath?: string,
): Promise<Partial<Record<TaskId, FixtureEntry>>> {
  // 1) Explicit override (tests).
  if (overridePath) {
    const raw = await readFile(overridePath, "utf8");
    return JSON.parse(raw);
  }
  // 2) Bundled fixture shipped with the eval module.
  const fixturePath = join(
    fileURLToPath(import.meta.url).replace(/\.js$/, "").replace(/\.ts$/, ""),
    "..",
    "fixtures",
    `${target}-tasks.json`,
  );
  try {
    const raw = await readFile(fixturePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    // Bundle path didn't resolve — surface to stderr rather than silently
    // marking every task as skipped (a hidden regression for the user).
    process.stderr.write(`[eval] failed to load fixture at ${fixturePath}: ${(e as Error).message}\n`);
    return {};
  }
}

interface FixtureEntry {
  assert?: { present?: unknown };
}

interface AssertionOutcome {
  pass: boolean;
  diff?: unknown;
  skipped: boolean;
}

/**
 * Fixture comparator. A `null` `assert.present` is the "skip me" signal —
 * the task is reported as `skipped: true` (it neither passes nor fails).
 * A non-null value triggers a structural deep-equal against `result.data`.
 * A mismatch returns `{ pass: false, diff: <first-mismatch path> }`.
 */
function assertResult(expected: FixtureEntry | undefined, actual: TaskResult): AssertionOutcome {
  if (!expected || !expected.assert || expected.assert.present === null || expected.assert.present === undefined) {
    return { pass: true, skipped: true };
  }
  if (!actual.ok) {
    return { pass: false, diff: { kind: "task-failed", error: actual.error ?? "(no error message)" }, skipped: false };
  }
  const expected_ = expected.assert.present;
  const diff = deepDiff(expected_, actual.data);
  if (diff === null) {
    return { pass: true, skipped: false };
  }
  return { pass: false, diff, skipped: false };
}

/**
 * Compare two JSON-shaped values. Returns `null` on match, or a description
 * of the first mismatch (path + actual). Conservative: returns the first
 * difference found; doesn't try to be exhaustive.
 */
function deepDiff(expected: unknown, actual: unknown, path = "$"): unknown | null {
  if (expected === actual) return null;
  if (typeof expected !== typeof actual) {
    return { path, expected, actual, reason: "type-mismatch" };
  }
  if (expected === null || actual === null) {
    return { path, expected, actual, reason: "null-mismatch" };
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return { path, expectedLen: expected.length, actualLen: actual.length, reason: "length-mismatch" };
    }
    for (let i = 0; i < expected.length; i++) {
      const d = deepDiff(expected[i], actual[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const eKeys = Object.keys(expected as object);
    const aKeys = Object.keys(actual as object);
    for (const k of eKeys) {
      if (!(k in (actual as object))) {
        return { path: `${path}.${k}`, reason: "missing-in-actual" };
      }
      const d = deepDiff((expected as any)[k], (actual as any)[k], `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  // Primitives.
  return { path, expected, actual, reason: "value-mismatch" };
}
