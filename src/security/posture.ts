/**
 * Nexus Dynamic Security Posture System — the governance foundation.
 *
 * Every substrate operation flows through the posture manager. The posture
 * determines WHAT operations are allowed. Authorization determines WHO can
 * escalate the posture. The audit stream records EVERYTHING.
 *
 * Posture levels (least to most permissive):
 *   AUDIT      — read-only observation, mapping, diagnostics
 *   COPILOT    — read + proposed actions, human approves each one
 *   AUTOPILOT  — pre-authorized execution within a defined scope
 *   RED_TEAM   — offensive operations within rules of engagement
 *   PURPLE_TEAM — coordinated offense/defense with real-time feedback
 */
import { createHash, randomBytes } from "node:crypto";

export enum SecurityPosture {
  AUDIT = "audit",
  COPILOT = "copilot",
  AUTOPILOT = "autopilot",
  RED_TEAM = "red_team",
  PURPLE_TEAM = "purple_team",
}

export const POSTURE_HIERARCHY: readonly SecurityPosture[] = [
  SecurityPosture.AUDIT,
  SecurityPosture.COPILOT,
  SecurityPosture.AUTOPILOT,
  SecurityPosture.RED_TEAM,
  SecurityPosture.PURPLE_TEAM,
];

/**
 * Substrates an operation can act upon.
 *
 * `"system"` denotes operations against the local runtime/control plane
 * (posture changes, authorization issuance, manifest/audit access, doctor)
 * rather than a remote target substrate.
 */
export type SubstrateType =
  | "web"
  | "desktop"
  | "mobile"
  | "terminal"
  | "network"
  | "system";
export type ImpactLevel = "read" | "modify" | "destroy" | "exfiltrate";

export const IMPACT_HIERARCHY: readonly ImpactLevel[] = ["read", "modify", "destroy", "exfiltrate"];

export interface AuthorizationScope {
  targets: string[];
  operations: string[];
  maxImpact: ImpactLevel;
  maxSubstrates: SubstrateType[];
  requireApprovalAbove?: string;
  maxActions?: number;
}

export interface PostureAuthorization {
  id: string;
  fromPosture: SecurityPosture;
  toPosture: SecurityPosture;
  scope: AuthorizationScope;
  approvers: string[];
  signatures: string[];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  auditStreamId: string;
  justification: string;
}

export interface PostureContext {
  currentPosture: SecurityPosture;
  authorization: PostureAuthorization | null;
  actionsRemaining: number;
  manifestHash?: string | null;
  auditStreamId?: string | null;
}

export interface OperationRequest {
  operation: string;
  substrate: SubstrateType;
  target: string;
  impact: ImpactLevel;
  params?: Record<string, unknown>;
}

export interface PostureDecision {
  allowed: boolean;
  reason: string;
  requiresApproval?: boolean;
  authorizationId?: string;
}

export interface AuditEvent {
  type: "posture.escalate" | "posture.deescalate" | "posture.revoke" | "operation.execute";
  authorizationId?: string;
  timestamp: number;
  from?: SecurityPosture;
  to?: SecurityPosture;
  scope?: AuthorizationScope;
  operation?: string;
  substrate?: SubstrateType;
  target?: string;
  impact?: ImpactLevel;
  success?: boolean;
  details?: string;
  actor?: string;
  manifestHash?: string;
}

export function postureAbove(p: SecurityPosture): SecurityPosture | null {
  const idx = POSTURE_HIERARCHY.indexOf(p);
  return idx < POSTURE_HIERARCHY.length - 1 ? POSTURE_HIERARCHY[idx + 1]! : null;
}

/**
 * Parse a URL-ish target into (host, path) for scope matching.
 *
 * Returns null for anything that is not a network identity — absolute URLs
 * without a hostname, bare words, window titles, file paths — so those keep
 * the legacy substring match. Bare hostnames (`app.example.com`,
 * `localhost:7311`) are accepted as host identities because that is how
 * operators write `--authorize-targets`.
 */
function parseHostPath(s: string): { host: string; path: string } | null {
  const raw = s.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    return { host: u.host.toLowerCase(), path: u.pathname || "/" };
  } catch {
    /* not an absolute URL — try bare-host form below */
  }
  // Bare host[:port][/path] — e.g. "app.example.com", "localhost:7311", "app.example.com/settings".
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?(\/[\s\S]*)?$/i.test(raw)) {
    return null;
  }
  const slash = raw.indexOf("/");
  const authority = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "/" : raw.slice(slash);
  return { host: authority, path };
}

export function generateAuthorizationId(): string {
  return randomBytes(16).toString("hex");
}

export function hashScope(scope: AuthorizationScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 16);
}

export class PostureManager {
  private currentPosture: SecurityPosture = SecurityPosture.AUDIT;
  private activeAuthorization: PostureAuthorization | null = null;
  private actionCount = 0;
  private auditLog: AuditEvent[] = [];
  private manifestHash: string | null = null;
  private auditStreamId: string | null = null;
  private auditSink: ((event: AuditEvent) => void | Promise<void>) | null = null;

  constructor(initialPosture: SecurityPosture = SecurityPosture.AUDIT) {
    this.currentPosture = initialPosture;
  }

  get posture(): SecurityPosture { return this.currentPosture; }

  get context(): PostureContext {
    return {
      currentPosture: this.currentPosture,
      authorization: this.activeAuthorization,
      actionsRemaining: this.activeAuthorization?.scope.maxActions
        ? Math.max(0, this.activeAuthorization.scope.maxActions - this.actionCount)
        : Infinity,
      manifestHash: this.manifestHash,
      auditStreamId: this.auditStreamId,
    };
  }

  setManifestHash(hash: string | null): void {
    this.manifestHash = hash;
  }

  getManifestHash(): string | null {
    return this.manifestHash;
  }

  setAuditStreamId(streamId: string | null): void {
    this.auditStreamId = streamId;
  }

  getAuditStreamId(): string | null {
    return this.auditStreamId;
  }

  attachAuditStream(sink: { record: (event: AuditEvent) => Promise<unknown> } | ((event: AuditEvent) => void | Promise<void>) | null): void {
    if (!sink) {
      this.auditSink = null;
    } else if (typeof sink === "function") {
      this.auditSink = sink;
    } else if (typeof sink.record === "function") {
      this.auditSink = (event) => void sink.record(event);
    }
  }

  detachAuditStream(): void {
    this.auditSink = null;
  }

  escalate(toPosture: SecurityPosture, scope: AuthorizationScope, approvers: string[], signatures: string[], justification: string, durationMs: number = 3_600_000): PostureAuthorization {
    this.assertCanEscalate(toPosture, approvers, signatures);
    const auth: PostureAuthorization = {
      id: randomBytes(16).toString("hex"), fromPosture: this.currentPosture, toPosture, scope,
      approvers, signatures, createdAt: Date.now(), expiresAt: Date.now() + durationMs,
      revoked: false, auditStreamId: `audit-${Date.now()}`, justification,
    };
    this.activeAuthorization = auth;
    this.currentPosture = toPosture;
    this.auditStreamId = auth.auditStreamId;
    this.actionCount = 0;
    this.recordAudit({ type: "posture.escalate", authorizationId: auth.id, from: auth.fromPosture, to: auth.toPosture, scope: auth.scope, timestamp: Date.now() });
    return auth;
  }

  deescalate(targetPosture?: SecurityPosture): void {
    if (!this.activeAuthorization) { this.currentPosture = targetPosture ?? SecurityPosture.AUDIT; return; }
    const from = this.currentPosture;
    this.currentPosture = targetPosture ?? this.activeAuthorization.fromPosture;
    this.recordAudit({ type: "posture.deescalate", authorizationId: this.activeAuthorization.id, from, to: this.currentPosture, timestamp: Date.now() });
    this.activeAuthorization = null;
    this.actionCount = 0;
  }

  revoke(): void {
    if (this.activeAuthorization) {
      this.activeAuthorization.revoked = true;
      this.recordAudit({ type: "posture.revoke", authorizationId: this.activeAuthorization.id, timestamp: Date.now() });
      this.deescalate();
    }
  }

  getAuditLog(): readonly AuditEvent[] { return this.auditLog; }

  private assertCanEscalate(to: SecurityPosture, approvers: string[], signatures: string[]): void {
    const currentIdx = POSTURE_HIERARCHY.indexOf(this.currentPosture);
    const toIdx = POSTURE_HIERARCHY.indexOf(to);
    if (toIdx <= currentIdx) throw new Error(`Cannot escalate from ${this.currentPosture} to ${to} (not higher)`);
    if (approvers.length === 0) throw new Error("At least one approver required for posture escalation");
    if (signatures.length !== approvers.length) throw new Error("Signature count must match approver count");
  }

  checkOperation(req: OperationRequest): PostureDecision {
    if (this.activeAuthorization) {
      if (this.activeAuthorization.revoked) return { allowed: false, reason: "Authorization has been revoked" };
      if (Date.now() > this.activeAuthorization.expiresAt) { this.deescalate(); return { allowed: false, reason: "Authorization has expired" }; }
      if (this.activeAuthorization.scope.maxActions && this.actionCount >= this.activeAuthorization.scope.maxActions) {
        return { allowed: false, reason: "Action limit reached for this authorization" };
      }
    }
    if (this.currentPosture === SecurityPosture.AUDIT) {
      if (req.impact !== "read") return { allowed: false, reason: "AUDIT posture allows only read operations" };
      return { allowed: true, reason: "Allowed in AUDIT posture" };
    }
    if (this.currentPosture === SecurityPosture.COPILOT) {
      if (req.impact === "read") return { allowed: true, reason: "Allowed in COPILOT posture" };
      return { allowed: true, requiresApproval: true, reason: "COPILOT requires per-action approval for non-read operations" };
    }
    const auth = this.activeAuthorization;
    if (!auth && this.currentPosture >= SecurityPosture.AUTOPILOT) {
      return { allowed: false, reason: `${this.currentPosture} posture requires an active authorization` };
    }
    if (auth) {
      if (!auth.scope.maxSubstrates.includes(req.substrate)) return { allowed: false, reason: `Substrate "${req.substrate}" not in authorized scope` };
      if (auth.scope.operations.length > 0 && !auth.scope.operations.includes(req.operation) && !auth.scope.operations.includes("*")) {
        return { allowed: false, reason: `Operation "${req.operation}" not in authorized scope` };
      }
      if (!this.matchesTarget(req.target, auth.scope.targets)) return { allowed: false, reason: `Target "${req.target}" not in authorized scope` };
      if (IMPACT_HIERARCHY.indexOf(req.impact) > IMPACT_HIERARCHY.indexOf(auth.scope.maxImpact)) {
        return { allowed: false, reason: `Impact "${req.impact}" exceeds authorized maximum "${auth.scope.maxImpact}"` };
      }
    }
    return { allowed: true, reason: `Allowed in ${this.currentPosture} posture`, authorizationId: auth?.id };
  }

  recordExecution(req: OperationRequest, result: { success: boolean; details?: string }): void {
    this.actionCount++;
    this.recordAudit({ type: "operation.execute", operation: req.operation, substrate: req.substrate, target: req.target, impact: req.impact, success: result.success, details: result.details, timestamp: Date.now() });
  }

  /**
   * R3-hardened target matching.
   *
   * - An EMPTY pattern list DENIES (no scope ⇒ no authorized targets). This is
   *   the fail-closed fix for the historical "empty = allow-all" footgun.
   * - `*` still allows everything (explicit wildcard opt-in).
   * - URL / host-shaped patterns match by host (+ port) and path prefix, so a
   *   lookalike host (`app.example.com.evil.io`) can never satisfy an
   *   authorization for `app.example.com` — substring matching across hosts
   *   was a scope bypass.
   * - Glob patterns are metacharacter-escaped before `*` → `.*` (no regex
   *   injection from patterns like `(`), and are boundary-anchored so
   *   `https://*.example.com` cannot match `https://app.example.com.evil.io`.
   * - Non-URL targets (page ids, window titles, device ids, file paths) keep
   *   the legacy substring match — they are not network identities.
   */
  private matchesTarget(target: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    if (patterns.includes("*")) return true;
    return patterns.some((p) => this.matchesTargetPattern(target, p));
  }

  private matchesTargetPattern(target: string, pattern: string): boolean {
    if (pattern === "*") return true;

    // Glob: escaped, then boundary-anchored at a path separator or end-of-string.
    if (pattern.includes("*")) {
      const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "\\*" : `\\${ch}`)).replace(/\\\*/g, ".*");
      return new RegExp(`^${body}(?:[/?#]|$)`).test(target);
    }

    const t = parseHostPath(target);
    const p = parseHostPath(pattern);
    if (t && p) {
      // Network identities: exact host (incl. port) + path-prefix scope.
      if (t.host !== p.host) return false;
      if (t.path === p.path) return true;
      const base = p.path.endsWith("/") ? p.path : `${p.path}/`;
      return t.path.startsWith(base);
    }
    // Non-URL identity (window title, page id, device id, …): legacy substring.
    return target.includes(pattern);
  }

  private recordAudit(event: AuditEvent): void {
    if (this.manifestHash && !event.manifestHash) {
      event.manifestHash = this.manifestHash;
    }
    this.auditLog.push(event);
    if (this.auditSink) {
      try {
        void this.auditSink(event);
      } catch {
        /* best-effort */
      }
    }
  }
}