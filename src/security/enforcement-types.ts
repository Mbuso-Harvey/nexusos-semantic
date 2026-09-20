/** @module enforcement-types
 * Enforcement subsystem (§10–§12): types, classifications, actor model,
 * attempt records, and cookie grant policy primitives.
 *
 * The registry impl + request pipeline live in `enforcement-registry.ts` and
 * `gateway.ts`. This module is intentionally type-first so gateway/manifest
 * can import shared shapes without circularity.
 */

import type {
  SecurityPosture,
  SubstrateType,
  ImpactLevel,
  PostureDecision,
  AuditEvent,
} from "./posture.js";
import type { ManifestSnapshot } from "./manifest.js";

// ---- Operation classification ------------------------------------------------

/** How an operation is classified for enforcement purposes. */
export enum OperationClassification {
  /** Pure read / discover — no side effects, lowest posture bar. */
  READ = "read",
  /** Write / state change — requires at least AUTOPILOT + scope. */
  WRITE = "write",
  /** Sensitive operation (billing, auth, destructive) — requires CONFIRM-grade posture or explicit grant. */
  SENSITIVE = "sensitive",
  /** Technique / capability execution — routed through the MCP execute path. */
  TECHNIQUE = "technique",
  /** Administrative / posture-changing operation. */
  ADMIN = "admin",
}

/** Whether a classification implies side effects (anything beyond read). */
export function isSideEffect(classification: OperationClassification): boolean {
  return classification !== OperationClassification.READ;
}

// ---- Operation kind union ---------------------------------------------------

export type OperationKind =
  | "graph_query"
  | "graph_path"
  | "graph_tool"
  | "graph_act"
  | "graph_explain"
  | "invoke_capability"
  | "posture_escalate"
  | "posture_deescalate"
  | "posture_revoke"
  | "authorize"
  | "manifest_snapshot"
  | "audit_read"
  | "audit_export"
  | "diagnostics"
  | "visual_read"
  | "visual_query"
  | "visual_diff"
  | "token_lint"
  | "token_export"
  | "crawl"
  | "auth_capture"
  | "desktop_read"
  | "desktop_act"
  | "mobile_read"
  | "mobile_act"
  | "chrome_read"
  | "chrome_act"
  | "chrome_cookies"
  | "system_doctor"
  | "session_capture";

/** A registered operation in the enforcement registry. */
export interface RegisteredOperation {
  /** Stable operation id (e.g. `"invoke_capability"`). */
  id: OperationKind;
  /** Human label. */
  label: string;
  /** Classification. */
  classification: OperationClassification;
  /** Substrates this operation may touch. */
  substrates: SubstrateType[];
  /** Max impact this operation can have (for scope checks). */
  maxImpact: ImpactLevel;
  /** When true, this operation requires an explicit sensitive grant even if posture would otherwise allow it. */
  requiresSensitiveGrant: boolean;
  /** Default impact level used when the caller does not specify one. */
  defaultImpact: ImpactLevel;
}

// ---- Cookie grant policy ---------------------------------------------------

/** Policy for granting access to sensitive cookies / auth state.
 *
 * The fail-closed variant: sensitive cookies are only accessible when an
 * explicit grant has been issued for the target origin + cookie name pattern.
 */
export interface SensitiveCookieGrant {
  /** Origin (e.g. `"https://app.example.com"`) the grant applies to. */
  origin: string;
  /** Cookie name pattern (glob). */
  cookiePattern: string;
  /** Which actor issued the grant. */
  issuedBy: string;
  /** When the grant was issued. */
  issuedAt: number;
  /** When the grant expires (ms epoch). */
  expiresAt: number;
  /** Revoked flag. */
  revoked: boolean;
  /** Optional justification. */
  justification?: string;
}

export interface CookieGrantPolicy {
  /** All grants in force. */
  grants: SensitiveCookieGrant[];
  /** Check whether a cookie access is granted for the given origin + cookie name. */
  isGranted(origin: string, cookieName: string): boolean;
  /** Issue a new grant. */
  issue(origin: string, cookiePattern: string, issuedBy: string, expiresAtMs: number, justification?: string): SensitiveCookieGrant;
  /** Revoke a grant by id. */
  revoke(origin: string, cookiePattern: string): boolean;
}

// ---- Enforcement actor ------------------------------------------------------

/** An actor in the enforcement system: a principal that performs operations. */
export interface EnforcementActor {
  /** Stable actor id (e.g. `"agent-1"`, `"operator-alice"`). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Actor type. */
  type: "agent" | "operator" | "system";
  /** Optional public key for authorization binding. */
  publicKey?: string;
  /** Actor metadata. */
  metadata?: Record<string, unknown>;
}

// ---- Attempt record --------------------------------------------------------

/** Outcome kind when an attempt is denied. */
export enum DenialKind {
  /** Operation not registered in the registry. */
  UNKNOWN_OPERATION = "unknown_operation",
  /** Operation registered but denied by classification / posture. */
  POSTURE_DENIED = "posture_denied",
  /** Denied by sensitive-cookie grant policy. */
  COOKIE_GRANT_DENIED = "cookie_grant_denied",
  /** Denied by authorization scope. */
  SCOPE_DENIED = "scope_denied",
  /** Denied because authorization revoked/expired. */
  AUTHORIZATION_EXPIRED = "authorization_expired",
  /** Denied because actor not authorized for this operation. */
  ACTOR_NOT_AUTHORIZED = "actor_not_authorized",
  /** Denied because attempt rate limit exceeded. */
  RATE_LIMITED = "rate_limited",
  /** Denied because posture escalation required. */
  ESCALATION_REQUIRED = "escalation_required",
  /** System-level denial (internal error path). */
  SYSTEM = "system",
}

export interface AttemptRecord {
  /** Unique attempt id. */
  attemptId: string;
  /** When the attempt was made. */
  timestamp: number;
  /** Actor performing the operation. */
  actor: EnforcementActor;
  /** Operation kind. */
  operation: OperationKind;
  /** Target (e.g. page url, capability id). */
  target: string;
  /** Substrate. */
  substrate: SubstrateType;
  /** Impact level. */
  impact: ImpactLevel;
  /** Whether the attempt was allowed. */
  allowed: boolean;
  /** Denial kind when `allowed === false`. */
  denialKind: DenialKind | null;
  /** Reason string. */
  reason: string;
  /** Manifest snapshot bound to the attempt (for audit reconstruction). */
  manifestSnapshot: ManifestSnapshot | null;
  /** Authorization id if one was active. */
  authorizationId: string | null;
  /** Optional classify result. */
  classification: OperationClassification;
  /** Optional extra details. */
  details?: string;
}

// ---- Attempt rate limiter ---------------------------------------------------

/** Thread-local attempt counter + rate tracking for the enforcement gateway. */
export interface AttemptRateLimiter {
  /** Maximum attempts per window. */
  maxAttempts: number;
  /** Window duration in ms. */
  windowMs: number;
  /** Attempt timestamps in the current window. */
  attempts: number[];
  /** Check whether a new attempt is allowed; records it if so. */
  check(now: number): boolean;
  /** Record an attempt. */
  record(now: number): void;
}

// ---- Audit event synthesis ---------------------------------------------------

/** Build an `AuditEvent` from an `AttemptRecord` + posture decision. */
export function auditEventFromAttempt(
  attempt: AttemptRecord,
  decision: PostureDecision | null,
): AuditEvent {
  const scope = attempt.manifestSnapshot?.manifest.scope;
  return {
    type: attempt.allowed ? "operation.execute" : "operation.execute",
    authorizationId: attempt.authorizationId ?? undefined,
    timestamp: attempt.timestamp,
    operation: attempt.operation,
    substrate: attempt.substrate as AuditEvent["substrate"],
    target: attempt.target,
    impact: attempt.impact as AuditEvent["impact"],
    success: attempt.allowed,
    details: attempt.reason,
    scope: scope ?? undefined,
  };
}
