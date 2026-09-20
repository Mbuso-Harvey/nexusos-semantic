/** @module gateway
 * Fail-closed security enforcement gateway (§10–§12).
 *
 * Sits beneath all transports (MCP, TCP server, CLI, crawler probes,
 * desktop, mobile) as the single invariant enforcement boundary:
 *   1. Classify operation via EnforcementRegistry (fail closed on unknown)
 *   2. Rate limit check via AttemptRateLimiter
 *   3. Sensitive cookie grant validation via CookieGrantPolicy
 *   4. Posture authorization check via PostureManager
 *   5. Inseparable audit recording (attempts, decisions, results)
 *   6. Guarded execution wrapper
 */

import {
  PostureManager,
  type OperationRequest,
  type PostureDecision,
  type PostureAuthorization,
  type AuthorizationScope,
  type AuditEvent,
  SecurityPosture,
  type SubstrateType,
  type ImpactLevel,
} from "./posture.js";
import { AuditStream } from "./audit.js";
import {
  type EngagementManifest,
  type ManifestSnapshot,
  snapshotManifest,
  createManifest,
  refreshManifest,
} from "./manifest.js";
import {
  OperationClassification,
  type OperationKind,
  type RegisteredOperation,
  type SensitiveCookieGrant,
  type CookieGrantPolicy,
  type EnforcementActor,
  DenialKind,
  type AttemptRecord,
  type AttemptRateLimiter,
  auditEventFromAttempt,
} from "./enforcement-types.js";
import {
  EnforcementRegistry,
  defaultCookieGrantPolicy,
  defaultAttemptRateLimiter,
  attemptFrom,
} from "./enforcement-registry.js";

// ---- Request & Result Shapes -----------------------------------------------

export interface GatewayRequest<TParams = Record<string, unknown>> {
  operation?: string;
  tool?: string;
  capabilityId?: string;
  method?: string;
  target?: string;
  substrate?: SubstrateType;
  impact?: ImpactLevel;
  actor?: EnforcementActor;
  params?: TParams;
  authorizationId?: string;
  sensitiveCookie?: {
    origin: string;
    cookieName: string;
  };
  confirm?: boolean;
  execute?: boolean;
  details?: string;
}

export interface GatewayResult<T = unknown> {
  allowed: boolean;
  denialKind?: DenialKind | null;
  reason: string;
  attempt: AttemptRecord;
  result?: T;
  error?: unknown;
  auditEvent?: AuditEvent;
  postureDecision?: PostureDecision;
}

export interface EnforcementGatewayOptions {
  registry?: EnforcementRegistry;
  postureManager?: PostureManager;
  cookieGrantPolicy?: CookieGrantPolicy;
  rateLimiter?: AttemptRateLimiter;
  manifest?: EngagementManifest | ManifestSnapshot | null;
  auditStream?: AuditStream | null;
  defaultActor?: EnforcementActor;
  requireDurableAudit?: boolean;
}

// ---- EnforcementGatewayBase ------------------------------------------------

export abstract class EnforcementGatewayBase {
  protected registry: EnforcementRegistry;
  protected postureManager: PostureManager;
  protected cookieGrantPolicy: CookieGrantPolicy;
  protected rateLimiter: AttemptRateLimiter;
  protected manifestSnapshot: ManifestSnapshot | null = null;
  protected auditStream: AuditStream | null = null;
  protected defaultActor: EnforcementActor;
  protected attempts: AttemptRecord[] = [];
  protected requireDurableAudit: boolean;

  constructor(opts: EnforcementGatewayOptions = {}) {
    this.registry = opts.registry ?? new EnforcementRegistry();
    this.postureManager = opts.postureManager ?? new PostureManager();
    this.cookieGrantPolicy = opts.cookieGrantPolicy ?? defaultCookieGrantPolicy();
    this.rateLimiter = opts.rateLimiter ?? defaultAttemptRateLimiter();
    this.auditStream = opts.auditStream ?? null;
    this.requireDurableAudit = opts.requireDurableAudit ?? false;
    this.defaultActor = opts.defaultActor ?? {
      id: "agent-default",
      name: "Default Agent",
      type: "agent",
    };

    if (opts.manifest) {
      this.setManifest(opts.manifest);
    }
    if (this.auditStream) {
      this.postureManager.attachAuditStream(this.auditStream);
    }
  }

  setManifest(manifest: EngagementManifest | ManifestSnapshot | null): void {
    if (!manifest) {
      this.manifestSnapshot = null;
      this.postureManager.setManifestHash(null);
      return;
    }
    if ("manifestHash" in manifest) {
      this.manifestSnapshot = manifest;
    } else {
      this.manifestSnapshot = snapshotManifest(manifest);
    }
    this.postureManager.setManifestHash(this.manifestSnapshot.manifestHash);
  }

  getManifest(): ManifestSnapshot | null {
    return this.manifestSnapshot;
  }

  /**
   * R2: bind the engagement manifest to the *verified* substrate hash.
   *
   * Called by serving entry points after the substrate is loaded and its
   * content hash computed, so the manifest binds to what is actually served
   * instead of the `sha256:unbound-graph` placeholder (or an operator claim
   * that was never checked). A no-op when the manifest is already bound to
   * this hash.
   */
  rebindGraphHash(graphHash: string): void {
    const snap = this.manifestSnapshot;
    if (!snap || snap.manifest.graphHash === graphHash) return;
    this.setManifest(refreshManifest(snap.manifest, { graphHash }));
  }

  setAuditStream(stream: AuditStream | null): void {
    this.auditStream = stream;
    if (stream) {
      this.postureManager.attachAuditStream(stream);
    } else {
      this.postureManager.detachAuditStream();
    }
  }

  getAuditStream(): AuditStream | null {
    return this.auditStream;
  }

  /** When true, *every* operation (including reads) fails closed if the audit
   *  record cannot be durably written. §11. */
  setRequireDurableAudit(required: boolean): void {
    this.requireDurableAudit = required;
  }

  getRequireDurableAudit(): boolean {
    return this.requireDurableAudit;
  }

  getRegistry(): EnforcementRegistry {
    return this.registry;
  }

  getPostureManager(): PostureManager {
    return this.postureManager;
  }

  getCookieGrantPolicy(): CookieGrantPolicy {
    return this.cookieGrantPolicy;
  }

  getAttempts(): readonly AttemptRecord[] {
    return this.attempts;
  }

  clearAttempts(): void {
    this.attempts = [];
  }

  abstract request<T>(
    req: GatewayRequest,
    execute?: () => Promise<T> | T,
  ): Promise<GatewayResult<T>>;

  abstract check(req: GatewayRequest): Promise<GatewayResult<never>>;

  async execute<T>(
    req: GatewayRequest,
    fn: () => Promise<T> | T,
  ): Promise<GatewayResult<T>> {
    return this.request(req, fn);
  }
}

// ---- EnforcementGateway (Pipeline Implementation) ---------------------------

export class EnforcementGateway extends EnforcementGatewayBase {
  constructor(opts: EnforcementGatewayOptions = {}) {
    super(opts);
  }

  async check(req: GatewayRequest): Promise<GatewayResult<never>> {
    return this.request<never>({ ...req, execute: false });
  }

  /**
   * Record a denied attempt (§11: denials are audited too).
   *
   * Denials always produce an `AttemptRecord` + `AuditEvent` in memory, and a
   * best-effort write to the durable audit stream when one is attached. The
   * attempt is never executed.
   */
  private async deny(
    req: GatewayRequest,
    op: RegisteredOperation | undefined,
    denialKind: DenialKind,
    reason: string,
    classification?: OperationClassification,
  ): Promise<GatewayResult<never>> {
    const actor = req.actor ?? this.defaultActor;
    const attempt = attemptFrom({
      registry: this.registry,
      actor,
      request: req,
      manifestSnapshot: this.manifestSnapshot,
      authorizationId: this.postureManager.context.authorization?.id ?? null,
      allowed: false,
      denialKind,
      reason,
      classification: classification ?? op?.classification ?? OperationClassification.TECHNIQUE,
      details: req.details,
    });

    this.attempts.push(attempt);

    const auditEvent = auditEventFromAttempt(attempt, null);
    auditEvent.actor = actor.id;
    if (this.manifestSnapshot) {
      auditEvent.manifestHash = this.manifestSnapshot.manifestHash;
    }
    if (this.auditStream) {
      try {
        await this.auditStream.record(auditEvent);
      } catch {
        /* best-effort: the denial itself already fails closed */
      }
    }

    return {
      allowed: false,
      denialKind,
      reason,
      attempt,
      auditEvent,
    };
  }

  // ---- Posture / authorization / audit control surface ----------------------

  /** Escalate posture under an explicit, approver-signed authorization. */
  escalatePosture(
    to: SecurityPosture,
    scope: AuthorizationScope,
    approvers: string[],
    signatures: string[],
    justification: string,
    durationMs?: number,
  ): PostureAuthorization {
    return this.postureManager.escalate(
      to,
      scope,
      approvers,
      signatures,
      justification,
      durationMs,
    );
  }

  /** Drop back to the posture carried by the active authorization (or AUDIT). */
  deescalatePosture(target?: SecurityPosture): void {
    this.postureManager.deescalate(target);
  }

  /** Emergency revocation of the active authorization. */
  revokeAuthorization(): void {
    this.postureManager.revoke();
  }

  /** Issue a sensitive cookie grant (required for sensitive cookie access). */
  issueCookieGrant(
    origin: string,
    cookiePattern: string,
    issuedBy: string,
    expiresAtMs?: number,
    justification?: string,
  ): SensitiveCookieGrant {
    return this.cookieGrantPolicy.issue(
      origin,
      cookiePattern,
      issuedBy,
      expiresAtMs ?? Date.now() + 3_600_000,
      justification,
    );
  }

  /** Revoke a sensitive cookie grant. */
  revokeCookieGrant(origin: string, cookiePattern: string): boolean {
    return this.cookieGrantPolicy.revoke(origin, cookiePattern);
  }

  async request<T>(
    req: GatewayRequest,
    execute?: () => Promise<T> | T,
  ): Promise<GatewayResult<T>> {
    const actor = req.actor ?? this.defaultActor;

    // Step 1: Operation classification & registry lookup (Fail closed)
    const opKind = this.registry.operationFor(req);
    const op = opKind ? this.registry.find(opKind) : undefined;

    if (!opKind || !op) {
      const label =
        req.operation ?? req.tool ?? req.method ?? req.capabilityId ?? "unspecified";
      return this.deny(
        req,
        undefined,
        DenialKind.UNKNOWN_OPERATION,
        `Unknown unclassified operation: "${label}" (fail-closed)`,
      );
    }

    // Step 2: Rate limit check
    const now = Date.now();
    if (!this.rateLimiter.check(now)) {
      return this.deny(req, op, DenialKind.RATE_LIMITED, "Attempt rate limit exceeded");
    }
    this.rateLimiter.record(now);

    // Step 3: Sensitive cookie grant check
    if (req.sensitiveCookie) {
      const { origin, cookieName } = req.sensitiveCookie;
      if (!this.cookieGrantPolicy.isGranted(origin, cookieName)) {
        return this.deny(
          req,
          op,
          DenialKind.COOKIE_GRANT_DENIED,
          `Sensitive cookie grant required for origin "${origin}" and cookie "${cookieName}"`,
        );
      }
    }

    // Step 4: Posture check
    const substrate: SubstrateType =
      req.substrate ?? (op.substrates[0] as SubstrateType ?? "web");
    const target = this.registry.resolveTarget(
      op.id,
      substrate,
      req.target ?? req.capabilityId ?? req.tool ?? req.method ?? req.operation ?? "unknown",
    );
    const impact: ImpactLevel = req.impact ?? op.defaultImpact;

    const postureDecision = this.postureManager.checkOperation({
      operation: op.id,
      substrate,
      target,
      impact,
      params: req.params as Record<string, unknown>,
    });

    if (!postureDecision.allowed) {
      return this.deny(
        { ...req, target, substrate, impact },
        op,
        DenialKind.POSTURE_DENIED,
        postureDecision.reason,
      );
    }

    if (postureDecision.requiresApproval && req.confirm !== true) {
      return this.deny(
        { ...req, target, substrate, impact },
        op,
        DenialKind.ESCALATION_REQUIRED,
        `Operation requires confirmation/approval: ${postureDecision.reason}`,
      );
    }
// Step 5: Allowed attempt record & audit synthesis
    const authId =
      postureDecision.authorizationId ??
      this.postureManager.context.authorization?.id ??
      req.authorizationId ??
      null;

    const attempt = attemptFrom({
      registry: this.registry,
      actor,
      request: { ...req, target, substrate, impact },
      manifestSnapshot: this.manifestSnapshot,
      authorizationId: authId,
      allowed: true,
      denialKind: null,
      reason: postureDecision.reason,
      classification: op.classification,
      details: req.details,
    });
    this.attempts.push(attempt);

    const auditEvent = auditEventFromAttempt(attempt, postureDecision);
    auditEvent.actor = actor.id;
    if (this.manifestSnapshot) {
      auditEvent.manifestHash = this.manifestSnapshot.manifestHash;
    }

    // Step 6: Durable audit enforcement (§11: if the audit record cannot be
    // durably written, execution fails closed for non-read operations).
    if (this.auditStream) {
      try {
        await this.auditStream.record(auditEvent);
      } catch (err) {
        if (
          this.requireDurableAudit ||
          op.classification !== OperationClassification.READ
        ) {
          const reason = `Durable audit write failed (fail-closed): ${
            err instanceof Error ? err.message : String(err)
          }`;
          // The attempt was already pushed as allowed; flip it in place so the
          // recorded history matches the decision that was actually enforced.
          attempt.allowed = false;
          attempt.denialKind = DenialKind.SYSTEM;
          attempt.reason = reason;
          return {
            allowed: false,
            denialKind: DenialKind.SYSTEM,
            reason,
            attempt,
            auditEvent,
          };
        }
      }
    }

    // Step 7: Guarded execution wrapper
    if (req.execute === false || !execute) {
      return {
        allowed: true,
        reason: postureDecision.reason,
        attempt,
        auditEvent,
        postureDecision,
      };
    }

    const opRequest: OperationRequest = {
      operation: op.id,
      substrate,
      target,
      impact,
      params: req.params as Record<string, unknown>,
    };

    try {
      const res = await execute();
      this.postureManager.recordExecution(opRequest, {
        success: true,
        details: attempt.reason,
      });
      return {
        allowed: true,
        reason: postureDecision.reason,
        attempt,
        result: res,
        auditEvent,
        postureDecision,
      };
    } catch (err) {
      this.postureManager.recordExecution(opRequest, {
        success: false,
        details: err instanceof Error ? err.message : String(err),
      });
      return {
        allowed: true, // Gate decision was allowed; the execution itself threw.
        reason: postureDecision.reason,
        attempt,
        error: err,
        auditEvent,
        postureDecision,
      };
    }
  }
}

// ---- Shared / Global Gateway Accessor ---------------------------------------

let defaultGatewayInstance: EnforcementGateway | null = null;

/** Returns the process-wide gateway, creating a default fail-closed one lazily. */
export function getEnforcementGateway(): EnforcementGateway {
  if (!defaultGatewayInstance) {
    defaultGatewayInstance = new EnforcementGateway();
  }
  return defaultGatewayInstance;
}

/** Replaces (or clears) the process-wide gateway. */
export function setEnforcementGateway(
  gateway: EnforcementGateway | null,
): void {
  defaultGatewayInstance = gateway;
}

// ---- Transport bootstrap (env / flag driven) --------------------------------

/**
 * Enforcement configuration resolved from the environment.
 *
 * The defaults are deliberately fail-closed:
 *   - `AWG_POSTURE` defaults to `audit` → read-only. Write / technique /
 *     sensitive operations are denied until an operator escalates.
 *   - `AWG_AUTHORIZED_TARGETS` defaults to `*` so an explicit escalation is
 *     still scoped by operation + impact + substrate.
 *   - No durable audit stream unless `AWG_AUDIT_DIR` is set.
 */
export interface EnforcementEnvConfig {
  posture: SecurityPosture;
  targets: string[];
  operations: string[];
  substrates: SubstrateType[];
  maxImpact: ImpactLevel;
  maxActions?: number;
  auditDir?: string;
  requireDurableAudit: boolean;
  actor: EnforcementActor;
  engagement?: string;
  /** Content hash of the graph revision this engagement is bound to
   *  (`AWG_GRAPH_HASH`). Defaults to a placeholder when unknown. */
  graphHash?: string;
}

function envList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : fallback;
}

/** Parse a posture name. Unknown / missing → AUDIT (fail closed). */
export function parsePosture(raw: string | undefined): SecurityPosture {
  switch ((raw ?? "").trim().toLowerCase().replace(/[-\s]/g, "_")) {
    case "copilot":
      return SecurityPosture.COPILOT;
    case "autopilot":
      return SecurityPosture.AUTOPILOT;
    case "red_team":
    case "redteam":
      return SecurityPosture.RED_TEAM;
    case "purple_team":
    case "purpleteam":
      return SecurityPosture.PURPLE_TEAM;
    case "audit":
    default:
      return SecurityPosture.AUDIT;
  }
}

/** Parse an impact level. Unknown / missing → `read` (fail closed). */
export function parseImpact(raw: string | undefined): ImpactLevel {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "modify":
      return "modify";
    case "destroy":
      return "destroy";
    case "exfiltrate":
      return "exfiltrate";
    case "read":
    default:
      return "read";
  }
}
/** Resolve enforcement configuration from an environment record. */
export function enforcementConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): EnforcementEnvConfig {
  const actorType = (env.AWG_ACTOR_TYPE ?? "agent") as EnforcementActor["type"];
  const maxActionsRaw = env.AWG_MAX_ACTIONS;
  const maxActions =
    maxActionsRaw !== undefined && Number.isFinite(Number(maxActionsRaw))
      ? Number(maxActionsRaw)
      : undefined;

  return {
    posture: parsePosture(env.AWG_POSTURE),
    targets: envList(env.AWG_AUTHORIZED_TARGETS, ["*"]),
    operations: envList(env.AWG_AUTHORIZED_OPERATIONS, ["*"]),
    substrates: envList(env.AWG_AUTHORIZED_SUBSTRATES, [
      "web",
      "desktop",
      "mobile",
      "terminal",
      "network",
      "system",
    ]) as SubstrateType[],
    maxImpact: parseImpact(env.AWG_MAX_IMPACT ?? "modify"),
    ...(maxActions !== undefined ? { maxActions } : {}),
    ...(env.AWG_AUDIT_DIR ? { auditDir: env.AWG_AUDIT_DIR } : {}),
    requireDurableAudit: env.AWG_REQUIRE_DURABLE_AUDIT === "1",
    actor: {
      id: env.AWG_ACTOR_ID ?? "agent-default",
      name: env.AWG_ACTOR_NAME ?? "Default Agent",
      type: actorType,
    },
    ...(env.AWG_ENGAGEMENT ? { engagement: env.AWG_ENGAGEMENT } : {}),
    ...(env.AWG_GRAPH_HASH ? { graphHash: env.AWG_GRAPH_HASH } : {}),
  };
}

/**
 * Bind the transport's enforcement configuration to a gateway (§12).
 *
 * This is the single bootstrap every transport (MCP, TCP server, CLI) calls so
 * posture / authorization / audit are structural rather than per-tool checks.
 * `AWG_POSTURE` defaults to `audit`, so nothing side-effecting runs until an
 * operator explicitly authorizes it.
 */
export async function configureEnforcement(
  config: EnforcementEnvConfig,
  gateway: EnforcementGateway = getEnforcementGateway(),
): Promise<EnforcementGateway> {
  // Durable audit (§11) is opt-in via AWG_AUDIT_DIR. When enabled, a write
  // failure fails closed for non-read operations (and for everything when
  // AWG_REQUIRE_DURABLE_AUDIT=1).
  if (config.auditDir) {
    const existingId = gateway.getPostureManager().getAuditStreamId();
    const streamId = existingId ?? `audit-${Date.now()}`;
    const stream = new AuditStream({ dir: config.auditDir, streamId });
    await stream.init();
    gateway.getPostureManager().setAuditStreamId(streamId);
    gateway.setAuditStream(stream);
    // One-shot processes (the CLI) must still persist buffered events on exit;
    // long-running servers flush on their own interval.
    process.once("beforeExit", () => {
      void stream.flush();
    });
  }
  gateway.setRequireDurableAudit(config.requireDurableAudit);

  // Posture escalation is never implicit: AUDIT stays AUDIT (fail closed).
  // Equal-posture re-bootstrap (double configure in one process) is silently
  // idempotent; a request to move DOWN is warned about, not swallowed, because
  // silently ignoring it hides a misconfigured profile from the operator.
  if (config.posture !== SecurityPosture.AUDIT) {
    const current = gateway.getPostureManager().posture;
    if (current !== config.posture) {
      try {
        gateway.escalatePosture(
          config.posture,
          {
            targets: config.targets,
            operations: config.operations,
            maxImpact: config.maxImpact,
            maxSubstrates: config.substrates,
            ...(config.maxActions !== undefined
              ? { maxActions: config.maxActions }
              : {}),
          },
          [config.actor.id],
          [`env:${config.actor.id}`],
          config.engagement ?? `Authorized via environment by ${config.actor.id}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/not higher/i.test(message)) throw err;
        console.error(
          `[enforcement] ignoring posture bootstrap to ${config.posture}: ${message}. ` +
            `Posture is monotonic within a process — call deescalatePosture() first if a lower profile was intended.`,
        );
      }
    }
  }

  // Hash-bound provenance: every decision/audit event carries the manifest hash.
  const ctx = gateway.getPostureManager().context;
  gateway.setManifest(
    createManifest({
      ...(config.engagement ? { description: config.engagement } : {}),
      graphHash: config.graphHash ?? "sha256:unbound-graph",
      posture: ctx.currentPosture,
      ...(ctx.authorization ? { authorizationId: ctx.authorization.id } : {}),
      scope: ctx.authorization?.scope ?? null,
      operator: config.actor.id,
    }),
  );

  return gateway;
}

/** Convenience: read the environment and configure the given/shared gateway. */
export async function configureEnforcementFromEnv(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
  gateway: EnforcementGateway = getEnforcementGateway(),
): Promise<EnforcementGateway> {
  const config = enforcementConfigFromEnv(env);

  // R3 (fail closed): never boot a side-effecting posture on wildcard or
  // implicit targets. The historical default `["*"]` (and the matcher's old
  // "empty = allow-all" behaviour) meant that setting AWG_POSTURE alone
  // authorized every host, operation and substrate. Wildcard targets are now
  // only valid at the read-only posture; leaving AUDIT requires an explicit,
  // non-wildcard target list. The programmatic `configureEnforcement()` API
  // keeps wildcard support for embedders and tests that construct their own
  // scopes deliberately.
  const wildcardTargets =
    config.targets.length === 0 || config.targets.includes("*");
  if (config.posture !== SecurityPosture.AUDIT && wildcardTargets) {
    throw new Error(
      `[enforcement] refusing posture '${config.posture}' with wildcard/implicit authorized targets. ` +
        `Set AWG_AUTHORIZED_TARGETS (or --authorize-targets) to the specific hosts this process may act on, ` +
        `e.g. --authorize-targets app.example.com. Wildcard targets are only valid at posture 'audit'.`,
    );
  }

  return configureEnforcement(config, gateway);
}

