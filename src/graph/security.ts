/**
 * Security tier definitions and decision logic. Plan section 12.
 *
 * Tiers in increasing order of authority (the floor for a capability is the
 * highest tier it has been assigned; promotion can only move it upward):
 *   DISCOVER  — graph.query/path/explain. No side effects. Free.
 *   READ      — read-only browser actions (Tab, Escape, navigation to whitelisted).
 *   PROPOSE   — state-changing inputs (textbox, slider, combobox, search).
 *   EXECUTE   — single click, link navigation, tab selection.
 *   CONFIRM   — destructive/billing/production. Server refuses unless confirm:true.
 */

export type SecurityTier = "DISCOVER" | "READ" | "PROPOSE" | "EXECUTE" | "CONFIRM";

const TIER_RANK: Record<SecurityTier, number> = {
  DISCOVER: 0,
  READ: 1,
  PROPOSE: 2,
  EXECUTE: 3,
  CONFIRM: 4,
};

/** Tier ordering: lower number = less authority. */
export function tierRank(t: SecurityTier): number {
  return TIER_RANK[t];
}

/** Return the higher (more restrictive) of two tiers. */
export function maxTier(a: SecurityTier, b: SecurityTier): SecurityTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// Destructive verb patterns (plan section 12). Conservative by design.
const DESTRUCTIVE_VERBS = /^(delete|remove|destroy|wipe|purge|terminate|cancel|drop|revoke|reset|clear|sign[ -]?out|log[ -]?out)\b/i;

// Billing / payment / production keywords — these can never be demoted below CONFIRM.
const SENSITIVE_KEYWORDS = /\b(billing|payment|checkout|invoice|subscription|production|prod[ -]?env|live[ -]?env|admin|owner|transfer|wire)\b/i;

/** Determine the security tier for a capability, given its role and aria-label. */
export function tierForCapability(opts: {
  role: string;
  name: string;
  inputKeys: string[];
}): SecurityTier {
  const { role, name, inputKeys } = opts;
  // Promotion to CONFIRM (highest, irreversible in v1)
  if (DESTRUCTIVE_VERBS.test(name)) return "CONFIRM";
  if (SENSITIVE_KEYWORDS.test(name)) return "CONFIRM";
  // Static rules from plan section 12
  if (inputKeys.length > 0 && role !== "link" && role !== "button") return "PROPOSE";
  if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "slider" || role === "spinbutton") return "PROPOSE";
  if (role === "checkbox" || role === "switch") return "EXECUTE";
  if (role === "button" || role === "link" || role === "menuitem" || role === "tab" || role === "option") return "EXECUTE";
  if (role === "dialog" || role === "alertdialog") return "EXECUTE";
  return "READ";
}

/** Decision the server returns to a `graph.act` caller. */
export interface ActDecision {
  ok: boolean;
  requireConfirm: boolean;
  reason: string;
  preview?: { capabilityId: string; tier: SecurityTier; role: string; name: string };
}

/** Decide whether a `graph.act` call may proceed. */
export function decide(opts: {
  tier: SecurityTier;
  capabilityId: string;
  role: string;
  name: string;
  confirm: boolean;
}): ActDecision {
  if (opts.tier === "DISCOVER") {
    return { ok: false, requireConfirm: false, reason: "DISCOVER capabilities cannot be invoked" };
  }
  if (opts.tier === "CONFIRM" && !opts.confirm) {
    return {
      ok: false,
      requireConfirm: true,
      reason: `${opts.tier}: capability is destructive or sensitive — requires confirm:true`,
      preview: { capabilityId: opts.capabilityId, tier: opts.tier, role: opts.role, name: opts.name },
    };
  }
  return { ok: true, requireConfirm: false, reason: "ok" };
}
