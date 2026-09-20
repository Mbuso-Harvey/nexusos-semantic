/** @module manifest
 * Engagement manifest hash binding + provenance snapshots for the enforcement
 * subsystem (§12). The manifest is the authoritative, hash-bound description of
 * the engagement that the gateway binds every decision/audit event to.
 *
 * An `EngagementManifest` captures the graph revision (by content hash), the
 * posture scope in force, the authorization id if one is active, and a
 * timestamped snapshot. The manifest hash is embedded in every
 * `AuditEvent` so auditors can reconstruct exactly which engagement description
 * a decision/decision-audit was made under.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AuthorizationScope, PostureAuthorization, SecurityPosture } from "./posture.js";

export interface EngagementManifest {
  /** Unique manifest id (random). */
  id: string;
  /** Monotonic revision counter, incremented on every bind/update. */
  revision: number;
  /** When the manifest was created / last updated (ms epoch). */
  updatedAt: number;
  /** Optional human description of the engagement. */
  description?: string;
  /** Graph revision content hash this manifest is bound to. */
  graphHash: string;
  /** Current posture in force at manifest time. */
  posture: SecurityPosture;
  /** Active authorization id, if one is bound. */
  authorizationId: string | null;
  /** Scope bound at manifest time (for audit reconstruction). */
  scope: AuthorizationScope | null;
  /** Optional operator / caller identity bound at manifest time. */
  operator?: string;
}

export interface ManifestSnapshot {
  manifest: EngagementManifest;
  /** SHA-256 of the canonical manifest payload (hex). */
  manifestHash: string;
  /** When the snapshot was taken. */
  snapshotAt: number;
}

const MANIFEST_PAYLOAD_FIELDS = [
  "id", "revision", "updatedAt", "description", "graphHash",
  "posture", "authorizationId", "scope", "operator",
] as const;

/** Canonical JSON payload used to compute the manifest hash. Only the listed
 * fields are included so the hash is stable and independent of any future
 * extensions to `EngagementManifest`. */
function manifestPayload(m: EngagementManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of MANIFEST_PAYLOAD_FIELDS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[k] = (m as any)[k];
  }
  return out;
}

/** Compute the manifest hash for a manifest. */
export function computeManifestHash(m: EngagementManifest): string {
  return createHash("sha256").update(JSON.stringify(manifestPayload(m))).digest("hex");
}

/** Create a fresh manifest for an engagement. */
export function createManifest(opts: {
  description?: string;
  graphHash: string;
  posture: SecurityPosture;
  authorizationId?: string;
  scope?: AuthorizationScope | null;
  operator?: string;
}): EngagementManifest {
  return {
    id: randomBytes(16).toString("hex"),
    revision: 1,
    updatedAt: Date.now(),
    description: opts.description,
    graphHash: opts.graphHash,
    posture: opts.posture,
    authorizationId: opts.authorizationId ?? null,
    scope: opts.scope ?? null,
    operator: opts.operator,
  };
}

/** Produce a `ManifestSnapshot` from a manifest (computes `manifestHash`). */
export function snapshotManifest(m: EngagementManifest): ManifestSnapshot {
  return {
    manifest: m,
    manifestHash: computeManifestHash(m),
    snapshotAt: Date.now(),
  };
}

/** Clone a manifest and bump its revision + updatedAt. */
export function refreshManifest(m: EngagementManifest, patch?: Partial<EngagementManifest>): EngagementManifest {
  const next: EngagementManifest = {
    ...m,
    revision: m.revision + 1,
    updatedAt: Date.now(),
    ...(patch ?? {}),
  };
  return next;
}
