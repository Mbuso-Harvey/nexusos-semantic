/**
 * State node id derivation (PR-8, ED-01 correction 2B).
 *
 * The Interaction/State Graph is a finite state machine. Each State
 * node has a *canonical payload*; the same payload always produces the
 * same id. The id is a stable hash of the canonicalized payload:
 *
 *   id = "state:" + sha256(canonicalJson(semanticPayload(payload)))
 *
 * The payload canonicalization rules:
 *   - Sort all object keys recursively.
 *   - Coerce AuthContext discriminators to a stable order.
 *   - NetworkContext.status is a string (or a branded template-literal
 *     type at the type level); it is used as-is.
 *   - The `elements` map is sorted by axId.
 *   - `openDialogIds`, `openPopoverIds`, `expandedRegionAxIds` are
 *     sorted lexicographically.
 *   - `conditionalMarkers` is sorted by key.
 *   - `viewport.scrollX/Y` and `dpr` are numeric; we keep them as-is
 *     (rounded to 3 decimal places for stability).
 *
 * **PR-8c T9 (declared + observed convergence).** The id is derived
 * from the *semantic* projection of the payload — the per-element
 * aria/visibility/open/expanded/selected/checked/pressed/busy fields
 * plus the structural fields (open dialogs/popovers, expanded
 * regions, viewport, auth, network, route, pageId). The `rect`,
 * `zIndex`, and `ariaStates` (and the `visualNodeId` cross-reference)
 * are part of the *observation* (per 2A) but are NOT part of the
 * canonical identity. This is the right call because:
 *   1. The declared path produces zero-rect placeholder observations
 *      while the observed path produces real geometry. If rect were
 *      in the id, the same application state would hash to two
 *      different ids depending on the evidence path — convergence
 *      would be impossible.
 *   2. The semantic projection is what an agent acts on: "is dialog
 *      D open?" not "is dialog D at rect (12, 34, 200, 80)?". The
 *      visual geometry is a *consequence* of the state, not the
 *      state itself.
 *
 * `visualFingerprint` is a smaller index derived from the same
 * payload (per 2A: NOT a substitute for `payload`).
 *
 * Both functions are pure, deterministic, and exported for unit testing.
 */
import { createHash } from "node:crypto";
import type {
  StatePayload, AuthContext, NetworkContext, ElementStateObservation,
} from "./types.js";

/** Stable, deep-clone with sorted object keys. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  // Discriminated union: AuthContext, NetworkContext are objects.
  // Sort the keys and recurse.
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = canonicalize(obj[k]);
  }
  return sorted;
}

/** Coerce a value to a fixed-precision number (for viewport etc.). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Project a payload to the *semantic* view used as the input to the
 *  state-id hash. The rect, zIndex, and visualNodeId are excluded;
 *  the resulting projection is identical for declared and observed
 *  evidence of the same application state. */
function projectToSemantic(p: StatePayload): StatePayload {
  return {
    pageId: p.pageId,
    route: p.route,
    auth: p.auth,
    network: p.network,
    elements: Object.fromEntries(
      Object.entries(p.elements)
        // Keep only the *semantic* per-element fields. The rect /
        // zIndex / visualNodeId are observations (per 2A) and are
        // NOT part of canonical state identity. Two states that
        // agree on this projection are the same state regardless of
        // the evidence path that produced them.
        .map(([axId, e]) => [axId, {
          visibility: e.visibility,
          open: e.open,
          expanded: e.expanded,
          selected: e.selected,
          checked: e.checked,
          pressed: e.pressed,
          busy: e.busy,
        }])
        .sort(([a], [b]) => (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0),
    ),
    openDialogIds: [...p.openDialogIds].sort(),
    openPopoverIds: [...p.openPopoverIds].sort(),
    expandedRegionAxIds: [...p.expandedRegionAxIds].sort(),
    // PR-8g T1: the State-level focus pointer IS part of canonical
    // state identity. Two states that differ on focusedAxId are
    // distinct application states (one has keyboard focus on
    // ax:foo, the other does not).
    focusedAxId: p.focusedAxId ?? null,
    viewport: {
      w: round3(p.viewport.w),
      h: round3(p.viewport.h),
      dpr: round3(p.viewport.dpr),
      scrollX: round3(p.viewport.scrollX),
      scrollY: round3(p.viewport.scrollY),
    },
    conditionalMarkers: Object.fromEntries(
      Object.entries(p.conditionalMarkers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    ),
  };
}

/** Round numeric fields of the payload to fixed precision. This is
 *  applied to the *semantic* projection (after the rect has been
 *  removed), so it only normalizes the viewport numbers. */
function stabilizeNumbers(p: StatePayload): StatePayload {
  const semantic = projectToSemantic(p);
  return {
    ...semantic,
    viewport: {
      w: round3(semantic.viewport.w),
      h: round3(semantic.viewport.h),
      dpr: round3(semantic.viewport.dpr),
      scrollX: round3(semantic.viewport.scrollX),
      scrollY: round3(semantic.viewport.scrollY),
    },
  };
}

/**
 * Derive a stable state id from a canonical payload. The id is
 * `state:<sha256-hex>` where the hash is over the JSON of the
 * canonicalized, number-stabilized payload.
 *
 * Pure: same input -> same output, every call.
 */
export function deriveStateId(payload: StatePayload): string {
  const stabilized = stabilizeNumbers(payload);
  const canonical = canonicalize(stabilized);
  const json = JSON.stringify(canonical);
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  return `state:${hash}`;
}

/**
 * Compute a smaller "visual fingerprint" of a payload for use as an
 * index. Per 2A: structured per-element observations, NOT an opaque
 * hash. The fingerprint is a sha256 of a small JSON projection that
 * includes the *visual* observations (visibility, open, expanded,
 * selected, checked, pressed, busy) but NOT the geometry (rect,
 * zIndex) — those are evidence-path-specific.
 *
 * **PR-8c T9.** The visual fingerprint and the canonical state id
 * now share the same semantic projection. The visual fingerprint is
 * kept as a separate, distinct hash for use as a content-addressed
 * index in the StateStore (per 2A) so a caller can quickly ask "is
 * there a state whose visual projection equals X?".
 */
export function computeVisualFingerprint(payload: StatePayload): string {
  const projection: unknown = projectToSemantic(payload);
  const json = JSON.stringify(canonicalize(projection));
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  return `vp:${hash}`;
}

/**
 * Build a StatePayload from the per-element observations captured by
 * the probe loop, plus the auth/network context at observation time.
 *
 * The route is the page's canonical URL. The pageId is the
 * `page:<canonicalUrl>` id.
 */
export function buildStatePayload(args: {
  pageId: string;
  route: string;
  auth: AuthContext;
  network: NetworkContext;
  elements: Record<string, ElementStateObservation>;
  focusedAxId: string | null;
  openDialogIds: string[];
  openPopoverIds: string[];
  expandedRegionAxIds: string[];
  viewport: { w: number; h: number; dpr: number; scrollX: number; scrollY: number };
  conditionalMarkers?: Record<string, string>;
}): StatePayload {
  return {
    pageId: args.pageId,
    route: args.route,
    auth: args.auth,
    network: args.network,
    elements: args.elements,
    focusedAxId: args.focusedAxId,
    openDialogIds: args.openDialogIds,
    openPopoverIds: args.openPopoverIds,
    expandedRegionAxIds: args.expandedRegionAxIds,
    viewport: args.viewport,
    conditionalMarkers: args.conditionalMarkers ?? {},
  };
}
