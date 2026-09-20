/**
 * A minimal in-memory Page mock for the eval task 4 test.
 *
 * Task 4 only uses `page.script.evaluate(expr)` and `page.script.callFunction(fn)`.
 * This mock records the invocations and returns canned values for the
 * `data-theme` get/set pattern.
 */
import type { ScriptTarget } from "../../../src/bidi-client/script.js";

export interface CallRecord {
  kind: "evaluate" | "callFunction";
  expression: string;
  args: unknown[];
}

export class MockPage {
  /** Mutable: tests flip between "light" and "dark" to simulate the click. */
  public theme: "light" | "dark" = "light";
  public calls: CallRecord[] = [];
  public readonly target: ScriptTarget = { context: "mock" };
  readonly script = {
    evaluate: async <T = unknown>(_t: ScriptTarget, expression: string): Promise<T> => {
      this.calls.push({ kind: "evaluate", expression, args: [] });
      // Match the real task 4 expression pattern.
      if (expression.includes("dataset.theme")) {
        return this.theme as unknown as T;
      }
      return null as unknown as T;
    },
    callFunction: async <T = unknown>(_t: ScriptTarget, _fn: string, args: unknown[] = []): Promise<T> => {
      this.calls.push({ kind: "callFunction", expression: _fn, args });
      // Simulate a successful click: flip the theme.
      this.theme = this.theme === "light" ? "dark" : "light";
      return undefined as unknown as T;
    },
  };
}
