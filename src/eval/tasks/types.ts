/**
 * Shared types for the 5 eval tasks (Stage 17).
 *
 * Every task takes a `TaskContext` and returns a `TaskResult`. The runner
 * wraps the call with timing + fixture comparison and writes the result to
 * `demo.trace.json`.
 */
import type { Graph } from "../../graph/graph.js";
import type { ScriptApi, ScriptTarget } from "../../bidi-client/script.js";

/**
 * Minimal structural type satisfied by the real `Page` class and by
 * test mocks. The eval tasks only need `page.target` (a ScriptTarget) and
 * `page.script.{evaluate, callFunction}` — nothing else from the BiDi
 * surface is required.
 */
export interface PageLike {
  readonly target: ScriptTarget;
  readonly script: Pick<ScriptApi, "evaluate" | "callFunction">;
}

export interface TaskContext {
  graph: Graph;
  /** Present only for tasks that perform a live browser action. */
  page?: PageLike;
  target: "synthetic" | "github";
}

export interface TaskResult {
  /** Did the task complete without throwing? */
  ok: boolean;
  /** Structured result the agent (or fixture comparator) inspects. */
  data: unknown;
  /** Human-readable error if ok === false. */
  error?: string;
}

export type TaskFn = (ctx: TaskContext) => Promise<TaskResult>;

/** Home-page URL patterns per target — the synthetic demo serves / and /index.html. */
export const HOME_PAGE_RE = /\/index\.html$|\/$/;
