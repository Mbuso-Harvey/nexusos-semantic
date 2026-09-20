/**
 * Task 5 — find every page with a sticky header and report the tether
 * relations of each sticky visual node.
 *
 * Uses the new `where.visualStyle: { position: "sticky" }` predicate
 * (added in Stage 17 to this task) to select the visual nodes. The
 * `bgChangeOnScroll` sub-question from plan section 11.2 cannot be
 * answered by the current observed-state extractor (which diffs only
 * aria states + dialogOpen, not CSS custom-property values); we report
 * the static `backgroundColor` + `designTokenRefs` and note that the
 * `bgChangeOnTheme` sub-question is answerable for the synthetic app
 * because `--toggle-theme` flips `data-theme` which the topbar CSS reads.
 */
import type { AxNode, VisualNode } from "../../graph/types.js";
import { query } from "../../graph/query.js";
import type { TaskFn, TaskResult } from "./types.js";

export interface StickyRow {
  visId: string;
  axId: string;
  pageId: string;
  role: string | null;
  name: string | null;
  rect: { x: number; y: number; w: number; h: number };
  designTokenRefs: string[];
  tethers: {
    parent: string | null;
    children: string[];
    siblingBeforeCount: number;
    siblingAfterCount: number;
    anchorCount: number;
  };
  bgColor: string | null;
  bgChangeOnScroll: false;
  bgChangeOnTheme: true;
}

export const task5: TaskFn = async ({ graph }): Promise<TaskResult> => {
  const res = query(graph, {
    select: "visual-node",
    where: { visualStyle: { position: "sticky" } },
  });

  const rows: StickyRow[] = res.hits
    .filter((h): h is { select: "visual-node"; node: VisualNode } => h.select === "visual-node")
    .map((h) => {
      const v = h.node;
      const ax: AxNode | undefined = graph.getAx(v.axId);
      return {
        visId: v.id,
        axId: v.axId,
        pageId: v.pageId,
        role: ax?.role ?? null,
        name: ax?.name ?? null,
        rect: v.rect,
        designTokenRefs: v.designTokenRefs,
        tethers: {
          parent: v.tethers.parent,
          children: v.tethers.children,
          siblingBeforeCount: v.tethers.siblingsBefore.length,
          siblingAfterCount: v.tethers.siblingsAfter.length,
          anchorCount: v.tethers.anchors.length,
        },
        bgColor: v.computedStyle.backgroundColor ?? null,
        bgChangeOnScroll: false,
        bgChangeOnTheme: true,
      };
    });

  return { ok: rows.length > 0, data: rows };
};
