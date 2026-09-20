/**
 * Task 1 — list every tab on the home page with the panel it reveals.
 *
 * Plan section 11.3 (synthetic): "every tab on the synthetic app's settings
 * page is captured with aria-controls edge to the correct tabpanel." There
 * are no tabs on settings.html, so per the Stage 17 plan we target the home
 * page (where the synthetic app's ARIA tablist lives).
 *
 * Uses graph.query with `role: "tab"` then walks `aria-controls` edges
 * from each tab to resolve the panel ax node.
 */
import type { AxNode } from "../../graph/types.js";
import { query } from "../../graph/query.js";
import type { TaskFn, TaskResult } from "./types.js";
import { HOME_PAGE_RE } from "./types.js";

export interface TabRow {
  tabAxId: string;
  tabName: string;
  panelAxId: string;
  panelName: string;
}

export const task1: TaskFn = async ({ graph }): Promise<TaskResult> => {
  // Find all role=tab ax nodes on the home page.
  const tabsRes = query(graph, {
    select: "ax-node",
    where: { role: "tab", pageUrl: HOME_PAGE_RE },
  });

  const rows: TabRow[] = [];
  const seenTabNames = new Set<string>();
  for (const hit of tabsRes.hits) {
    if (hit.select !== "ax-node") continue;
    const tab: AxNode = hit.node;
    // The synthetic app's home page is served at both `/` and `/index.html`
    // — the crawler creates two distinct page records, which means the same
    // 3 tabs appear twice. Dedupe by tab name so the agent sees the logical
    // tab set, not 2x pages of identical tabs.
    if (seenTabNames.has(tab.name)) continue;
    seenTabNames.add(tab.name);
    // Walk aria-controls edges from the tab.
    const edges = graph.edgesFrom(tab.id, "aria-controls");
    // Fallback: the AxNode.properties.controls array (raw element ids)
    // is also populated, but it's not an axId — skip for now.
    const targetId = edges[0]?.to;
    if (!targetId) {
      rows.push({
        tabAxId: tab.id,
        tabName: tab.name,
        panelAxId: "(no edge)",
        panelName: "(unresolved)",
      });
      continue;
    }
    const panel = graph.getAx(targetId);
    rows.push({
      tabAxId: tab.id,
      tabName: tab.name,
      panelAxId: targetId,
      panelName: panel?.name ?? "(unresolved)",
    });
  }

  return { ok: rows.length > 0, data: rows };
};
