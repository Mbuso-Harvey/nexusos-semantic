/**
 * Capability executor (ED-02 / PR-9).
 *
 * `invokeCapability(g, page, req)` is the execute-path counterpart to
 * `prepareAct`. Both functions exist; `prepareAct` is the security
 * decision gate, `invokeCapability` is the gate + execute. The
 * execute step is the PR-9 binding:
 *
 *   1. Call `prepareAct` to get the security decision.
 *   2. If the decision is not ok, return immediately (same as
 *      `prepareAct`). CONFIRM capabilities without `confirm: true`
 *      never reach the substrate — security posture is preserved
 *      (see `src/graph/security.ts:67-86`).
 *   3. If `req.execute === false`, return the decision + binding
 *      without touching the page. This is the "dry-run" mode for
 *      agents that want the pre-flight shape without committing.
 *   4. If no `page` was supplied, return a clear "no page attached"
 *      error rather than hanging.
 *   5. If the capability's `pageId` resolves to a different URL
 *      than the current page URL, navigate the page to the
 *      capability's URL first. (PR-9 v1 owns one tab; multi-tab
 *      is a v2 enhancement. The page-Id-→-URL mapping is via
 *      `g.getPage(cap.pageId)?.canonicalUrl`.)
 *   6. Locate the bound element via the capability's `selector`
 *      (re-resolve hint per plan section 8.3). If the selector
 *      resolves to zero elements, return a clear "selector did
 *      not resolve" error.
 *   7. Read the element's bounding rect via
 *      `page.script.evaluate(...)` and compute the viewport
 *      center.
 *   8. Route the action by ax role:
 *        - `textbox` | `searchbox` | `combobox` | `spinbutton` →
 *          `page.input.type(context, input.text ?? "")`
 *        - `button` | `link` | `menuitem` | `tab` | `option` |
 *          `checkbox` | `switch` | `radio` → `page.input.click(
 *          context, x, y)` (rect center)
 *        - any other role → return a clear "no execute path for
 *          role" error rather than guessing.
 *   9. After the action, capture the post-action URL via
 *      `page.url`. If `req.evidence === true`, also capture a
 *      screenshot via `page.screenshot()`.
 *  10. Return `{ ok: true, tier, capabilityId, decision, binding,
 *      observe: { url, elapsedMs, screenshotRef? } }`. On any
 *      error in steps 4–9, return `{ ok: false, decision, observe:
 *      { url, error } }` — never throw. The MCP `graph_invoke`
 *      tool surfaces the result as a structured tool response.
 *
 * The execute path is owned by this module so the rest of the
 * graph layer stays substrate-free (per the "server owns the
 * substrate" invariant).
 */
import type { Page } from "../bidi-client/page.js";
import type { Graph } from "../graph/graph.js";
import { prepareAct, type ActRequest, type ActResult } from "../graph/tools.js";
import type { ActDecision, SecurityTier } from "../graph/security.js";
import type { AxNode, Capability } from "../graph/types.js";
import { getEnforcementGateway } from "../security/index.js";
import type { ImpactLevel } from "../security/index.js";

/**
 * Map a capability security tier onto an enforcement impact level.
 *
 * The tier system (`src/graph/security.ts`) classifies *capabilities*; the
 * enforcement gateway classifies *operations* and their impact. This is the
 * bridge between the two: read-only tiers map to `read`, state-changing tiers
 * map to `modify`, and destructive/billing tiers map to `destroy`.
 */
export function impactForTier(tier: SecurityTier): ImpactLevel {
  switch (tier) {
    case "DISCOVER":
    case "READ":
      return "read";
    case "PROPOSE":
    case "EXECUTE":
      return "modify";
    case "CONFIRM":
      return "destroy";
    default:
      return "read";
  }
}

/** Request shape for `invokeCapability`. Extends `ActRequest` with
 *  the execute-path controls. */
export interface InvokeRequest extends ActRequest {
  /** When `false`, return the decision + binding without firing
   *  any BiDi action. Default `true`. */
  execute?: boolean;
  /** When `true`, capture a post-action screenshot via
   *  `page.screenshot()` and include the base64 in
   *  `observe.screenshotRef`. Default `false`. */
  evidence?: boolean;
}

export interface ObserveOk {
  /** Post-action page URL. `null` only in the dry-run
   *  short-circuit (when `req.execute === false` and no page
   *  is touched). */
  url: string | null;
  /** Wall-clock ms from the start of the execute step to its
   *  end. Useful for agent timeouts and for ED-01 follow-up
   *  performance analysis. */
  elapsedMs: number;
  /** Base64-encoded PNG when `req.evidence === true`. */
  screenshotRef?: string;
}

export interface ObserveErr {
  url: string | null;
  error: string;
}

export type InvokeResult =
  | {
      ok: true;
      tier: SecurityTier;
      capabilityId: string;
      decision: ActDecision;
      binding: { axId: string; selector: string; pageId: string };
      observe: ObserveOk;
    }
  | {
      ok: false;
      decision: ActDecision;
      observe: ObserveErr;
    };

const ROLES_TYPE = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const ROLES_CLICK = new Set([
  "button", "link", "menuitem", "tab", "option",
  "checkbox", "switch", "radio",
]);

export async function invokeCapability(
  g: Graph,
  page: Page | null,
  req: InvokeRequest,
): Promise<InvokeResult> {
  const t0 = Date.now();
  // Step 1 — gate. Reuse prepareAct; this is the single point of
  // security enforcement for both decision and execute paths.
  const decision = prepareAct(g, req);
  if (!decision.ok) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: decision.decision.reason },
    };
  }
  // Step 2 — dry-run short-circuit.
  if (req.execute === false) {
    return {
      ok: true,
      tier: decision.tier,
      capabilityId: decision.capabilityId,
      decision: decision.decision,
      binding: decision.binding,
      observe: { url: null, elapsedMs: Date.now() - t0 },
    };
  }
  // Step 3 — page must be attached.
  if (!page) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: "no page attached — server owns no BiDi tab for this call" },
    };
  }
  // Step 4 — fetch capability + ax for the binding.
  const cap = g.getCapability(req.capabilityId);
  const ax = cap ? g.getAx(cap.binding.axId) : null;
  if (!cap || !ax) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: `capability or binding ax missing: ${req.capabilityId}` },
    };
  }
  // Step 5 — §10–§12 enforcement boundary. Everything from here down has side
  // effects (navigation, kinetic dispatch, screenshots), so the gateway decides
  // *here*: classify `invoke_capability`, check posture/authorization, and
  // record the attempt + audit event before any substrate call is made.
  const gate = await getEnforcementGateway().request<InvokeResult>(
    {
      operation: "graph.invoke",
      capabilityId: req.capabilityId,
      target: g.getPage(cap.pageId)?.canonicalUrl ?? cap.pageId,
      substrate: "web",
      impact: impactForTier(decision.tier),
      confirm: req.confirm === true,
      params: { input: req.input ?? {}, evidence: req.evidence === true },
      details: `invoke ${req.capabilityId} (tier ${decision.tier}, role ${ax.role})`,
    },
    () => executeInvoke(g, page, req, decision, cap, ax, t0),
  );

  if (!gate.allowed) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: gate.reason },
    };
  }
  if (gate.error !== undefined) {
    return {
      ok: false,
      decision: decision.decision,
      observe: {
        url: null,
        error: gate.error instanceof Error ? gate.error.message : String(gate.error),
      },
    };
  }
  return gate.result as InvokeResult;
}

/**
 * Steps 5–10 of the execute path: navigate, re-resolve the binding, dispatch the
 * kinetic action, and capture post-action evidence.
 *
 * This function is only reachable through the enforcement gateway, so the
 * invariant from §10 — *no side-effecting operation exists below the enforcement
 * boundary* — holds for every transport (MCP, TCP server, CLI).
 */
async function executeInvoke(
  g: Graph,
  page: Page,
  req: InvokeRequest,
  decision: Extract<ActResult, { ok: true }>,
  cap: Capability,
  ax: AxNode,
  t0: number,
): Promise<InvokeResult> {
  // Step 5 — navigate to the capability's page if we are not
  // already there. (PR-9 v1 owns one tab; the executor moves the
  // tab to the capability's page before each invoke. This is the
  // simplest correct behavior and is what an SDK caller would do
  // by hand in the v1 decision-only flow.)
  const targetPage = g.getPage(cap.pageId);
  if (targetPage) {
    try {
      const currentUrl = await page.url;
      if (currentUrl !== targetPage.canonicalUrl) {
        await page.navigate(targetPage.canonicalUrl);
      }
    } catch (e) {
      return {
        ok: false,
        decision: decision.decision,
        observe: { url: null, error: `navigate to ${targetPage.canonicalUrl} failed: ${String((e as Error).message)}` },
      };
    }
  }
  // Step 6 — confirm the selector still resolves on the live
  // page. The BiDi `browsingContext.locateNodes` call returns
  // empty when the page has changed and the selector no longer
  // matches anything. We use it as a presence check before
  // attempting the click.
  try {
    const located = await page.locate({ type: "css", value: cap.binding.selector });
    if (located.length === 0) {
      return {
        ok: false,
        decision: decision.decision,
        observe: { url: null, error: `selector did not resolve to any element: ${cap.binding.selector}` },
      };
    }
  } catch (e) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: `locate by selector '${cap.binding.selector}' failed: ${String((e as Error).message)}` },
    };
  }
  // Step 7 — read the rect. We re-resolve via the same selector
  // (the binding's `selector` is the re-resolve hint per plan
  // section 8.3) and call `getBoundingClientRect()` in the page
  // context. Using the selector (rather than the BiDi sharedId)
  // is simpler and avoids leaking the substrate handle across
  // the wire; if the locator above succeeded, the selector must
  // still resolve to at least one element.
  let rect: { x: number; y: number; w: number; h: number };
  try {
    rect = await page.script.evaluate<{ x: number; y: number; w: number; h: number }>(
      page.target,
      `(() => { const el = document.querySelector(${JSON.stringify(cap.binding.selector)}); if (!el) return {x:0,y:0,w:0,h:0}; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()`,
    );
  } catch (e) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: `read bounding rect failed: ${String((e as Error).message)}` },
    };
  }
  if (!rect || rect.w === 0 || rect.h === 0) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: `element has zero-area rect: ${cap.binding.selector}` },
    };
  }
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);
  // Step 8 — route by role.
  try {
    if (ROLES_TYPE.has(ax.role)) {
      const text = (req.input && typeof req.input.text === "string") ? req.input.text : "";
      await page.input.click(page.context, cx, cy);
      const focused = await page.script.evaluate<boolean>(
        page.target,
        `(() => document.activeElement === document.querySelector(${JSON.stringify(cap.binding.selector)}))()`,
      );
      if (!focused) {
        return {
          ok: false,
          decision: decision.decision,
          observe: { url: null, error: `bound element did not own focus after click: ${cap.binding.selector}` },
        };
      }
      await page.input.type(page.context, text);
    } else if (ROLES_CLICK.has(ax.role)) {
      await page.input.click(page.context, cx, cy);
    } else {
      return {
        ok: false,
        decision: decision.decision,
        observe: { url: null, error: `no execute path for role: ${ax.role}` },
      };
    }
  } catch (e) {
    return {
      ok: false,
      decision: decision.decision,
      observe: { url: null, error: `execute failed: ${String((e as Error).message)}` },
    };
  }
  // Step 9 — capture post-action state.
  let postUrl: string;
  try {
    postUrl = await page.url;
  } catch {
    postUrl = "";
  }
  let screenshotRef: string | undefined;
  if (req.evidence === true) {
    try {
      const shot = await page.screenshot();
      screenshotRef = shot.bidi.data;
    } catch {
      // Evidence is best-effort; the action still completed.
    }
  }
  return {
    ok: true,
    tier: decision.tier,
    capabilityId: decision.capabilityId,
    decision: decision.decision,
    binding: decision.binding,
    observe: { url: postUrl, elapsedMs: Date.now() - t0, ...(screenshotRef ? { screenshotRef } : {}) },
  };
}
