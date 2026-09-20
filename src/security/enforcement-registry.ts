/** @module enforcement-registry
 * Enforcement registry, actor model, cookie grant policy, and attempt
 * bookkeeping implementation (§10–§12).
 *
 * Fail-closed: any operation not explicitly registered is denied by default.
 * Sensitive-cookie grant policy: operations that touch sensitive cookies
 * require an explicit grant.
 */

import { randomBytes } from "node:crypto";
import {
  OperationClassification,
  type OperationKind,
  type RegisteredOperation,
  type SensitiveCookieGrant,
  type CookieGrantPolicy,
  type EnforcementActor,
  type DenialKind,
  type AttemptRecord,
  type AttemptRateLimiter,
} from "./enforcement-types.js";
import type { ManifestSnapshot } from "./manifest.js";

// ---- Cookie grant policy default implementation ---------------------------

function globMatch(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    const re = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$").replace(/\*/g, ".*") + "$",
      "i",
    );
    return re.test(name);
  }
  return pattern === name;
}

export function defaultCookieGrantPolicy(): CookieGrantPolicy {
  return {
    grants: [],
    isGranted(origin, cookieName) {
      if (!origin || !cookieName) return false;
      return this.grants.some(
        (g) =>
          !g.revoked &&
          g.expiresAt > Date.now() &&
          g.origin === origin &&
          globMatch(g.cookiePattern, cookieName),
      );
    },
    issue(origin, cookiePattern, issuedBy, expiresAtMs, justification) {
      const grant: SensitiveCookieGrant = {
        origin,
        cookiePattern,
        issuedBy,
        issuedAt: Date.now(),
        expiresAt: expiresAtMs > Date.now() ? expiresAtMs : Date.now() + 3_600_000,
        revoked: false,
        justification,
      };
      this.grants.push(grant);
      return grant;
    },
    revoke(origin, cookiePattern) {
      const idx = this.grants.findIndex(
        (g) => !g.revoked && g.origin === origin && g.cookiePattern === cookiePattern,
      );
      if (idx < 0) return false;
      this.grants[idx]!.revoked = true;
      return true;
    },
  };
}

// ---- Attempt rate limiter default ------------------------------------------

export function defaultAttemptRateLimiter(): AttemptRateLimiter {
  return {
    maxAttempts: 1_000,
    windowMs: 60_000,
    attempts: [],
    check(now) {
      const cutoff = now - this.windowMs;
      this.attempts = this.attempts.filter((t) => t > cutoff);
      return this.attempts.length < this.maxAttempts;
    },
    record(now) {
      const cutoff = now - this.windowMs;
      this.attempts = this.attempts.filter((t) => t > cutoff);
      this.attempts.push(now);
    },
  };
}

// ---- Enforcement registry ---------------------------------------------------

/** Fail-closed registry of all operations the enforcement subsystem knows about. */
export class EnforcementRegistry {
  private operations: Map<OperationKind, RegisteredOperation> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /** Register a single operation. Idempotent re-register with identical values is allowed; conflicts throw. */
  register(op: RegisteredOperation): void {
    const existing = this.operations.get(op.id);
    if (existing) {
      if (
        existing.label !== op.label ||
        existing.classification !== op.classification ||
        existing.substrates.length !== op.substrates.length ||
        existing.maxImpact !== op.maxImpact ||
        existing.requiresSensitiveGrant !== op.requiresSensitiveGrant ||
        existing.defaultImpact !== op.defaultImpact
      ) {
        throw new Error(
          `EnforcementRegistry: attempt to re-register operation "${op.id}" with conflicting definition`,
        );
      }
      return;
    }
    this.operations.set(op.id, op);
  }

  /** Look up a registered operation by id. Undefined => fail-closed (caller must deny). */
  find(id: OperationKind): RegisteredOperation | undefined {
    return this.operations.get(id);
  }

  /** Return all registered operations. */
  list(): ReadonlyArray<RegisteredOperation> {
    return Array.from(this.operations.values());
  }

  /** Resolve a target string to a canonical form for the given operation + substrate. */
  resolveTarget(op: OperationKind, substrate: string, target: string): string {
    if (substrate === "web") {
      try {
        const url = new URL(target);
        return url.href;
      } catch {
        return target;
      }
    }
    return target;
  }

  /** Derive the operation kind from a generic request descriptor.
   *
   * Normalizes common aliases used across the MCP tools, server, and CLI.
   */
  operationFor(request: {
    tool?: string;
    operation?: string;
    capabilityId?: string;
    method?: string;
  }): OperationKind | undefined {
    const key =
      request.operation ?? request.tool ?? request.method ?? (request.capabilityId ? "invoke_capability" : undefined);
    if (!key) return undefined;

    if (key === "graph.query" || key === "graph_query") return "graph_query";
    if (key === "graph.path" || key === "graph_path") return "graph_path";
    if (key === "graph.tool" || key === "graph_tool") return "graph_tool";
    if (key === "graph.explain" || key === "graph_explain") return "graph_explain";
    // graph_live_read — live page/element snapshot (optional navigation within the
    // already-trusted graph). Classified as a read; it carries no write side effect
    // and is the safe counterpart to graph_invoke.
    if (key === "graph.liveRead" || key === "graph_live_read") return "graph_query";
    if (
      key === "graph.invoke" ||
      key === "invoke_capability" ||
      key === "graph_invoke"
    )
      return "invoke_capability";
    if (key === "posture.escalate" || key === "posture_escalate") return "posture_escalate";
    if (key === "posture.deescalate" || key === "posture_deescalate") return "posture_deescalate";
    if (key === "posture.revoke" || key === "posture_revoke") return "posture_revoke";
    if (key === "authorize" || key === "authorize_operation") return "authorize";
    if (key === "manifest.snapshot" || key === "manifest_snapshot") return "manifest_snapshot";
    if (key === "audit.read" || key === "audit_read") return "audit_read";
    if (key === "audit.export" || key === "audit_export") return "audit_export";
    if (key === "diagnostics" || key === "graph_diagnostics") return "diagnostics";
    // R2: substrate provenance read — pure graph-local read, no side effects.
    if (key === "substrate.info" || key === "substrate_info") return "diagnostics";
    if (
      key === "visual_diff" ||
      key === "graph_visualRegression" ||
      key === "visualRegression"
    )
      return "visual_diff";
    if (
      key === "token.lint" ||
      key === "token_lint" ||
      key === "lint_tokens" ||
      key === "graph_lintTokens"
    )
      return "token_lint";
    if (
      key === "token.export" ||
      key === "token_export" ||
      key === "export_tokens" ||
      key === "graph_exportTokens"
    )
      return "token_export";
    if (key === "crawl" || key === "crawl_start") return "crawl";
    // R5: crawl job status is a pure read over the job table; cancel requires
    // the same authority as starting one (stop what you could have started).
    if (key === "crawl_status") return "diagnostics";
    if (key === "crawl_cancel") return "crawl";
    if (key === "auth_capture" || key === "auth_capture_flow") return "auth_capture";
    if (key === "desktop_act" || key === "desktop_kinetic_action") return "desktop_act";
    if (key === "mobile_act" || key === "mobile_act") return "mobile_act";
    if (key === "system_doctor" || key === "doctor") return "system_doctor";
    if (key === "session_capture") return "session_capture";

    // graph.act / graph_act — capability decision surface (no execution).
    if (key === "graph.act" || key === "graph_act") return "graph_act";

    // Visual read surfaces (VI-01..VI-03) — graph-local reads.
    if (
      key === "get_visual" ||
      key === "graph.getVisual" ||
      key === "get_visual_patterns" ||
      key === "graph.visualPatterns" ||
      key === "get_visual_containers" ||
      key === "graph.visualContainers" ||
      key === "get_spatial_neighbors" ||
      key === "graph.spatialNeighbors" ||
      key === "get_occluded_nodes" ||
      key === "graph.occludedNodes"
    )
      return "visual_read";

    // Visual query surfaces (VI-01/VI-04) — graph-local reads across viewports.
    if (
      key === "query_viewport_diff" ||
      key === "graph.viewportDiff" ||
      key === "query_page_layout_mutations" ||
      key === "graph.pageLayoutMutations"
    )
      return "visual_query";

    // Visual regression (VI-05) — graph-local read.
    if (key === "query_visual_regression" || key === "graph.visualRegression")
      return "visual_diff";

    // Token surfaces (VI-05).
    if (
      key === "lint_design_tokens" ||
      key === "graph.lintTokens" ||
      key === "export_dtcg_tokens" ||
      key === "graph.exportTokens"
    )
      return key.startsWith("export") || key === "graph.exportTokens"
        ? "token_export"
        : "token_lint";

    // Desktop surfaces (Phase D3).
    if (
      key === "desktop_list_windows" ||
      key === "desktop_scrape_window" ||
      key === "desktop_read_text" ||
      key === "desktop.list" ||
      key === "desktop.scrape"
    )
      return "desktop_read";
    if (
      key === "desktop_kinetic_action" ||
      key === "desktop_replace_text" ||
      key === "desktop.action"
    )
      return "desktop_act";

    // Chrome CDP surfaces (Phase D4).
    if (
      key === "chrome_targets" ||
      key === "chrome_read_tab" ||
      key === "chrome_snapshot_tab"
    )
      return "chrome_read";
    if (key === "chrome_get_cookies") return "chrome_cookies";
    if (key === "chrome_navigate" || key === "chrome_launch")
      return "chrome_act";

    // Mobile surfaces (Phase M3).
    if (key === "mobile_list_devices" || key === "mobile_scrape_device")
      return "mobile_read";
    if (key === "mobile_touch_action") return "mobile_act";

    if (this.operations.has(key as OperationKind)) return key as OperationKind;
    return undefined;
  }

  private registerDefaults(): void {
    const defs: RegisteredOperation[] = [
      {
        id: "graph_query",
        label: "Graph query",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "graph_path",
        label: "Graph path traversal",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "graph_tool",
        label: "List graph tools / capabilities",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "graph_explain",
        label: "Graph explain / provenance",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "invoke_capability",
        label: "Invoke a capability (execute path)",
        classification: OperationClassification.TECHNIQUE,
        substrates: ["web"],
        maxImpact: "modify",
        requiresSensitiveGrant: true,
        defaultImpact: "modify",
      },
      {
        id: "posture_escalate",
        label: "Posture escalation",
        classification: OperationClassification.ADMIN,
        substrates: ["system"],
        maxImpact: "exfiltrate",
        requiresSensitiveGrant: true,
        defaultImpact: "modify",
      },
      {
        id: "posture_deescalate",
        label: "Posture de-escalation",
        classification: OperationClassification.ADMIN,
        substrates: ["system"],
        maxImpact: "modify",
        requiresSensitiveGrant: false,
        defaultImpact: "modify",
      },
      {
        id: "posture_revoke",
        label: "Posture revocation",
        classification: OperationClassification.ADMIN,
        substrates: ["system"],
        maxImpact: "destroy",
        requiresSensitiveGrant: true,
        defaultImpact: "destroy",
      },
      {
        id: "authorize",
        label: "Emit authorization",
        classification: OperationClassification.ADMIN,
        substrates: ["system"],
        maxImpact: "modify",
        requiresSensitiveGrant: true,
        defaultImpact: "modify",
      },
      {
        id: "manifest_snapshot",
        label: "Manifest snapshot",
        classification: OperationClassification.READ,
        substrates: ["system"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "audit_read",
        label: "Read audit log",
        classification: OperationClassification.READ,
        substrates: ["system"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "audit_export",
        label: "Export audit log",
        classification: OperationClassification.READ,
        substrates: ["system"],
        maxImpact: "exfiltrate",
        requiresSensitiveGrant: true,
        defaultImpact: "exfiltrate",
      },
      {
        id: "diagnostics",
        label: "Server diagnostics",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "visual_diff",
        label: "Visual regression diff",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "token_lint",
        label: "Design token drift lint",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "token_export",
        label: "Export design tokens",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "exfiltrate",
        requiresSensitiveGrant: true,
        // The bundle is produced from the local graph, so the default impact is
        // a read. `maxImpact` records the sensitive ceiling (tokens are design
        // IP), and `requiresSensitiveGrant` forces the cookie/grant check when
        // the request carries sensitive session material.
        defaultImpact: "read",
      },
      {
        id: "crawl",
        label: "Web crawl",
        classification: OperationClassification.TECHNIQUE,
        substrates: ["web"],
        maxImpact: "modify",
        requiresSensitiveGrant: true,
        defaultImpact: "modify",
      },
      {
        id: "auth_capture",
        label: "Auth state capture",
        classification: OperationClassification.SENSITIVE,
        substrates: ["web"],
        maxImpact: "exfiltrate",
        requiresSensitiveGrant: true,
        defaultImpact: "exfiltrate",
      },
      {
        id: "desktop_act",
        label: "Desktop kinetic action",
        classification: OperationClassification.TECHNIQUE,
        substrates: ["desktop"],
        maxImpact: "modify",
        requiresSensitiveGrant: true,
        defaultImpact: "modify",
      },
      {
        id: "mobile_act",
        label: "Mobile substrate action",
        classification: OperationClassification.TECHNIQUE,
        substrates: ["mobile"],
        maxImpact: "modify",
        requiresSensitiveGrant: true,
        defaultImpact: "modify",
      },
      {
        id: "system_doctor",
        label: "System doctor check",
        classification: OperationClassification.READ,
        substrates: ["system"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "session_capture",
        label: "Session capture (cookies + origins)",
        classification: OperationClassification.SENSITIVE,
        substrates: ["web"],
        maxImpact: "exfiltrate",
        requiresSensitiveGrant: true,
        defaultImpact: "exfiltrate",
      },
      // ---- MCP / server / CLI surfaces added for §10 classification coverage.
      // Every transport surface is registered here; anything NOT registered
      // fails closed at the gateway.
      {
        id: "graph_act",
        label: "Capability decision (no execution)",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "visual_read",
        label: "Visual element read (snapshot / patterns / containers / neighbors)",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "visual_query",
        label: "Visual query (viewport diff / layout mutations)",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "desktop_read",
        label: "Desktop window read (list / scrape)",
        classification: OperationClassification.READ,
        substrates: ["desktop"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "mobile_read",
        label: "Mobile device read (list / scrape)",
        classification: OperationClassification.READ,
        substrates: ["mobile"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "chrome_read",
        label: "Chrome CDP read (targets / DOM / snapshot)",
        classification: OperationClassification.READ,
        substrates: ["web"],
        maxImpact: "read",
        requiresSensitiveGrant: false,
        defaultImpact: "read",
      },
      {
        id: "chrome_act",
        label: "Chrome CDP action (navigate / launch)",
        classification: OperationClassification.TECHNIQUE,
        substrates: ["web"],
        maxImpact: "modify",
        requiresSensitiveGrant: true,
        defaultImpact: "modify",
      },
      {
        id: "chrome_cookies",
        label: "Chrome cookie extraction",
        classification: OperationClassification.SENSITIVE,
        substrates: ["web"],
        maxImpact: "exfiltrate",
        requiresSensitiveGrant: true,
        defaultImpact: "exfiltrate",
      },
    ];
    for (const op of defs) this.register(op);
  }
}

// ---- Attempt bookkeeping ---------------------------------------------------

/** Create an `AttemptRecord` for an attempt (allowed or denied). */
export function attemptFrom(opts: {
  registry: EnforcementRegistry;
  actor: EnforcementActor;
  request: {
    operation?: string;
    tool?: string;
    capabilityId?: string;
    method?: string;
    target?: string;
    substrate?: string;
    impact?: string;
    params?: Record<string, unknown>;
  };
  manifestSnapshot: ManifestSnapshot | null;
  authorizationId: string | null;
  allowed: boolean;
  denialKind: DenialKind | null;
  reason: string;
  classification: OperationClassification;
  details?: string;
}): AttemptRecord {
  const request = opts.request;
  const opId = (opts.registry.operationFor(request) ?? (
    request.capabilityId ? "invoke_capability" : "unknown_operation"
  )) as OperationKind;

  const resolvedTarget =
    request.target ?? request.capabilityId ?? request.tool ?? request.method ?? request.operation ?? "unknown";
  const resolvedSubstrate = request.substrate ?? "web";
  const resolvedImpact = request.impact ?? "read";

  return {
    attemptId: randomBytes(12).toString("hex"),
    timestamp: Date.now(),
    actor: opts.actor,
    operation: opId,
    target: opts.registry.resolveTarget(opId, resolvedSubstrate, String(resolvedTarget)),
    substrate: resolvedSubstrate as any,
    impact: resolvedImpact as any,
    allowed: opts.allowed,
    denialKind: opts.denialKind,
    reason: opts.reason,
    manifestSnapshot: opts.manifestSnapshot,
    authorizationId: opts.authorizationId,
    classification: opts.classification,
    details: opts.details,
  };
}
