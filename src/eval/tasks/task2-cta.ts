/**
 * Task 2 — find the primary CTA button.
 *
 * Plan section 11.3 (synthetic) calls for the CTA to bind to DTCG
 * `color.action.primary.bg` — but the synthetic app's sidecar only defines
 * `color.accent`. Per the Stage 17 plan we filter on `color.accent` instead
 * and document the swap.
 *
 * Scope: the plan's "home page" was wrong for the actual demo — the primary
 * CTA (the button whose visual node references `color.accent`) is on
 * `/tickets.html`, not on `/`. We therefore search the entire site, scoped
 * by target: the synthetic app's origin (127.0.0.1:7311) for the synthetic
 * target, or unfiltered for github.
 *
 * For GitHub the heuristic is: a button whose name matches /sign up|get
 * started|try/i.
 */
import type { AxNode } from "../../graph/types.js";
import { query } from "../../graph/query.js";
import type { TaskFn, TaskResult } from "./types.js";

export interface CtaRow {
  axId: string;
  name: string;
  pageId: string;
  designTokenRefs: string[];
  rect: { x: number; y: number; w: number; h: number };
}

export const task2: TaskFn = async ({ graph, target }): Promise<TaskResult> => {
  if (target === "synthetic") {
    // Synthetic: any button whose visual node references `color.accent`.
    // We can't use a `pageUrl` filter because the CTA lives on /tickets.html
    // in the actual demo, not on the home page.
    const candidates = query(graph, {
      select: "ax-node",
      where: { role: "button" },
    });
    for (const hit of candidates.hits) {
      if (hit.select !== "ax-node") continue;
      const ax: AxNode = hit.node;
      const vis = graph.visualByAx(ax.id);
      if (!vis) continue;
      if (!vis.designTokenRefs.includes("color.accent")) continue;
      const row: CtaRow = {
        axId: ax.id,
        name: ax.name,
        pageId: ax.pageId,
        designTokenRefs: vis.designTokenRefs,
        rect: vis.rect,
      };
      return { ok: true, data: row };
    }
    return { ok: false, data: null, error: "no button with color.accent in designTokenRefs" };
  }

  // GitHub: button whose name matches signup-style pattern.
  const candidates = query(graph, {
    select: "ax-node",
    where: { role: "button", name: /sign\s*up|get\s+started|try\s+github/i },
  });
  if (candidates.hits.length === 0) {
    return { ok: false, data: null, error: "no GitHub signup-style button found" };
  }
  const hit = candidates.hits.find((h) => h.select === "ax-node");
  if (!hit || hit.select !== "ax-node") {
    return { ok: false, data: null, error: "no ax-node match" };
  }
  const ax: AxNode = hit.node;
  const vis = graph.visualByAx(ax.id);
  const row: CtaRow = {
    axId: ax.id,
    name: ax.name,
    pageId: ax.pageId,
    designTokenRefs: vis?.designTokenRefs ?? [],
    rect: vis?.rect ?? { x: 0, y: 0, w: 0, h: 0 },
  };
  return { ok: true, data: row };
};
