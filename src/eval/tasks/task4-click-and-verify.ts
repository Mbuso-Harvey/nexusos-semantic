/**
 * Task 4 — click the custom Invoker Command `--toggle-theme` and verify
 * that `document.documentElement.dataset.theme` flips.
 *
 * Plan section 11.2 (GitHub) calls for clicking the user-menu dropdown,
 * but the synthetic app's popover open/close does not show up in the
 * current observed-snapshot diff (popovers have no `aria-expanded`).
 * The synthetic app does have a `--toggle-theme` invoker that flips
 * `data-theme` on `<html>`, which is a clean, observable state change.
 * Per the Stage 17 plan we use this for the live-action task.
 *
 * Walker-fn contract (per the locked-in 2026-08-29 gotcha): the
 * `functionDeclaration` MUST be a bare function expression, not an IIFE
 * — Firefox BiDi wraps it and calls `.apply(args)` on the result; an
 * IIFE-wrapped arrow evaluates to the result object, breaking `.apply`.
 */
import type { AxNode } from "../../graph/types.js";
import { query } from "../../graph/query.js";
import type { TaskFn, TaskResult } from "./types.js";
import { HOME_PAGE_RE } from "./types.js";

export interface ToggleThemeRow {
  axId: string;
  before: string;
  after: string;
  flipped: boolean;
}

export const task4: TaskFn = async ({ graph, page, target }): Promise<TaskResult> => {
  if (!page) {
    return { ok: false, data: null, error: "task4 requires a live Page" };
  }
  if (target === "github") {
    return {
      ok: false,
      data: null,
      error: "github target not yet implemented for task4 (placeholder fixture)",
    };
  }

  // 1. Find the toggle-theme button by name on the home page.
  const tabsRes = query(graph, {
    select: "ax-node",
    where: { role: "button", pageUrl: HOME_PAGE_RE, name: /toggle\s*theme/i },
  });
  const hit = tabsRes.hits.find((h): h is { select: "ax-node"; node: AxNode } => h.select === "ax-node");
  if (!hit) {
    return { ok: false, data: null, error: "toggle-theme button not found in graph" };
  }
  const btn: AxNode = hit.node;

  // 2. Read theme before.
  const before = await page.script.evaluate<string>(
    page.target,
    "document.documentElement.dataset.theme ?? 'light'",
  );

  // 3. Click via BiDi script.callFunction. Bare arrow form per the contract.
  //    The synthetic app's toggle button has id="theme-toggle" in the HTML —
  //    a simple DOM lookup avoids needing a complex sharedId resolution path.
  await page.script.callFunction<void>(
    page.target,
    "() => { const e = document.getElementById('theme-toggle'); if (e) e.click(); }",
  );

  // 4. Read theme after.
  const after = await page.script.evaluate<string>(
    page.target,
    "document.documentElement.dataset.theme ?? 'light'",
  );

  return {
    ok: before !== after,
    data: { axId: btn.id, before, after, flipped: before !== after } as ToggleThemeRow,
  };
};
