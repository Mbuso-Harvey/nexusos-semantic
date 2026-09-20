/**
 * Task 3 — list WebMCP-shaped capabilities matching a name pattern.
 *
 * Plan section 11.3 (synthetic) names `create_issue` and `update_settings`,
 * but the synthetic app declares `create_ticket` / `search_docs` /
 * `delete_workspace`. Per the Stage 17 plan the regex is `/(create|update)/i`
 * to match the spec's intent against the actual demo data.
 */
import type { AxNode, Capability } from "../../graph/types.js";
import { listTools } from "../../graph/tools.js";
import type { TaskFn, TaskResult } from "./types.js";

export interface CapabilityRow {
  id: string;
  name: string;
  security: string;
  axId: string;
  pageId: string;
  source: string;
  a11y: { role: string; name: string } | null;
}

export const task3: TaskFn = async ({ graph }): Promise<TaskResult> => {
  const result = listTools(graph, { name: /(create|update)/i });
  const data: CapabilityRow[] = result.capabilities.map((c: Capability) => {
    const ax: AxNode | undefined = graph.getAx(c.binding.axId);
    return {
      id: c.id,
      name: c.name,
      security: c.security,
      axId: c.binding.axId,
      pageId: c.pageId,
      source: c.source,
      a11y: ax ? { role: ax.role, name: ax.name } : null,
    };
  });
  return { ok: data.length > 0, data };
};
