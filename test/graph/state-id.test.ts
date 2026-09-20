/**
 * Unit tests for the State Graph ID derivation (PR-8 / ED-01 correction 2B).
 *
 * `deriveStateId(payload)` must be a pure function: same payload -> same
 * id, every call. The id is `state:<sha256-hex>` of the canonicalized,
 * number-stabilized JSON payload. `computeVisualFingerprint(payload)` is
 * a separate, smaller index over the same payload.
 */
import { describe, it, expect } from "vitest";
import {
  deriveStateId,
  computeVisualFingerprint,
  buildStatePayload,
} from "../../src/graph/state-id.js";
import { Graph } from "../../src/graph/graph.js";
import type { AuthContext, NetworkContext } from "../../src/graph/types.js";

const NO_NETWORK: NetworkContext = { status: "online", evidence: "static" };
const ANON: AuthContext = { kind: "anonymous" };

function payloadWith(over: Record<string, any> = {}) {
  return buildStatePayload({
    pageId: "page:https://x/",
    route: "https://x/",
    auth: ANON,
    network: NO_NETWORK,
    elements: {},
    // PR-8g T1: State-level focus pointer. Default null in the
    // test helper; tests that exercise focus set it explicitly.
    focusedAxId: null,
    openDialogIds: [],
    openPopoverIds: [],
    expandedRegionAxIds: [],
    viewport: { w: 1280, h: 800, dpr: 1, scrollX: 0, scrollY: 0 },
    ...over,
  });
}

describe("deriveStateId", () => {
  it("is pure: same payload -> same id", () => {
    const p = payloadWith();
    expect(deriveStateId(p)).toBe(deriveStateId(p));
  });

  it("is deterministic across calls (no shared mutable state)", () => {
    const p = payloadWith();
    const a = deriveStateId(p);
    const b = deriveStateId(p);
    const c = deriveStateId(p);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("is key-order independent (canonicalizes object keys)", () => {
    // Two payloads with the same data, written in different key orders,
    // must produce the same id.
    const p1 = buildStatePayload({
      pageId: "p", route: "r", auth: ANON, network: NO_NETWORK,
      elements: {}, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: { w: 1, h: 1, dpr: 1, scrollX: 0, scrollY: 0 },
    });
    // Mutate the input map order — the function must canonicalize.
    const p2 = { ...p1, elements: { ...p1.elements } };
    expect(deriveStateId(p1)).toBe(deriveStateId(p2));
  });

  it("distinguishes auth contexts", () => {
    const anon = payloadWith({ auth: { kind: "anonymous" } });
    const alice = payloadWith({
      auth: { kind: "authenticated", principal: "alice", session: "s1" },
    });
    const admin = payloadWith({
      auth: { kind: "administrator", principal: "bob", session: "s2" },
    });
    expect(deriveStateId(anon)).not.toBe(deriveStateId(alice));
    expect(deriveStateId(alice)).not.toBe(deriveStateId(admin));
    expect(deriveStateId(anon)).not.toBe(deriveStateId(admin));
  });

  it("distinguishes network evidence", () => {
    const staticN = payloadWith({ network: { status: "online", evidence: "static" } });
    const shimN = payloadWith({ network: { status: "online", evidence: "page-instrumented" } });
    const bidiN = payloadWith({ network: { status: "online", evidence: "bidi:network" } });
    expect(deriveStateId(staticN)).not.toBe(deriveStateId(shimN));
    expect(deriveStateId(shimN)).not.toBe(deriveStateId(bidiN));
  });

  it("includes pageId and route in the id", () => {
    const a = payloadWith({ pageId: "page:https://a/", route: "https://a/" });
    const b = payloadWith({ pageId: "page:https://b/", route: "https://b/" });
    expect(deriveStateId(a)).not.toBe(deriveStateId(b));
  });

  it("includes viewport (different scroll -> different id)", () => {
    const a = payloadWith({ viewport: { w: 1, h: 1, dpr: 1, scrollX: 0, scrollY: 0 } });
    const b = payloadWith({ viewport: { w: 1, h: 1, dpr: 1, scrollX: 100, scrollY: 0 } });
    expect(deriveStateId(a)).not.toBe(deriveStateId(b));
  });

  it("includes per-element state (aria change -> new id)", () => {
    // PR-8c T9: the canonical id is derived from the *semantic*
    // projection (visibility / open / expanded / selected / checked
    // / pressed / busy). ariaStates and the rect are observations
    // (per 2A) and are NOT part of the identity. The pre-PR-8c test
    // asserted that an ariaStates change produces a new id; with
    // T9's fix that is no longer true. The right invariant is the
    // one below: a real semantic change (e.g. `expanded` flips
    // from null to true) DOES produce a new id.
    const a = payloadWith({
      elements: {
        "ax:1": {
          axId: "ax:1",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          visibility: "visible",
          zIndex: 0, open: null, expanded: false, selected: null, checked: null, pressed: null, busy: null,
          ariaStates: { "aria-expanded": "false" },
          visualNodeId: null,
        },
      },
    });
    const b = payloadWith({
      elements: {
        "ax:1": {
          axId: "ax:1",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          visibility: "visible",
          zIndex: 0, open: null, expanded: true, selected: null, checked: null, pressed: null, busy: null,
          ariaStates: { "aria-expanded": "true" },
          visualNodeId: null,
        },
      },
    });
    expect(deriveStateId(a)).not.toBe(deriveStateId(b));
  });

  it("PR-8c T9: rect / zIndex / ariaStates / visualNodeId are NOT part of the canonical id", () => {
    // Two payloads that differ ONLY in their observations (rect,
    // zIndex, ariaStates, visualNodeId) must produce the same id.
    // The semantic projection is identical (visibility + open +
    // expanded + ... all match). This is the convergence invariant
    // that makes declared + observed evidence hash to the same id.
    const decl = payloadWith({
      elements: {
        "ax:1": {
          axId: "ax:1",
          rect: { x: 0, y: 0, w: 0, h: 0 },        // declared path
          visibility: "visible",
          zIndex: null,
          open: null, expanded: true, selected: null, checked: null, pressed: null, busy: null,
          ariaStates: {},
          visualNodeId: null,
        },
      },
    });
    const obs = payloadWith({
      elements: {
        "ax:1": {
          axId: "ax:1",
          rect: { x: 12, y: 34, w: 200, h: 80 },  // observed path
          visibility: "visible",
          zIndex: 5,
          open: null, expanded: true, selected: null, checked: null, pressed: null, busy: null,
          ariaStates: { "aria-expanded": "true" },
          visualNodeId: "vis:1",
        },
      },
    });
    expect(deriveStateId(decl)).toBe(deriveStateId(obs));
  });

  it("PR-8c T9: declared and observed convergence yields evidence kind 'declared+observed'", () => {
    // This test exercises the convergence logic in graph.upsertState:
    // upserting a state with `evidence: [{ kind: "declared" }]`
    // followed by a state with `evidence: [{ kind: "observed" }]`
    // (both with the same id) produces a state node whose
    // evidence[] entries have `kind: "declared+observed"`.
    const g = new Graph();
    const p = payloadWith({
      openDialogIds: ["ax:dlg"],
      elements: {
        "ax:1": {
          axId: "ax:1",
          rect: { x: 0, y: 0, w: 0, h: 0 },
          visibility: "visible",
          zIndex: null,
          open: null, expanded: true, selected: null, checked: null, pressed: null, busy: null,
          ariaStates: {},
          visualNodeId: null,
        },
      },
    });
    const id = deriveStateId(p);
    g.upsertState({
      id, type: "state", pageId: p.pageId, payload: p,
      visualFingerprint: computeVisualFingerprint(p),
      authContext: p.auth, networkContext: p.network, provenance: "html:parse",
      firstObservedAt: "2026-08-30T00:00:00.000Z",
      evidence: [{ kind: "declared", sourceAxId: "ax:1", transitionId: null, at: "2026-08-30T00:00:00.000Z" }],
    });
    g.upsertState({
      id, type: "state", pageId: p.pageId, payload: p,
      visualFingerprint: computeVisualFingerprint(p),
      authContext: p.auth, networkContext: p.network, provenance: "dom-diff:probe",
      firstObservedAt: "2026-08-30T00:00:00.000Z",
      evidence: [{ kind: "observed", sourceAxId: "ax:1", transitionId: null, at: "2026-08-30T00:00:01.000Z" }],
    });
    const s = g.getState(id)!;
    expect(s).toBeDefined();
    expect(s.evidence).toHaveLength(2);
    // After convergence, both evidence entries have been promoted
    // to "declared+observed".
    for (const ev of s.evidence) {
      expect(ev.kind).toBe("declared+observed");
    }
  });

  it("returns ids prefixed with `state:` and a hex sha256", () => {
    const id = deriveStateId(payloadWith());
    expect(id.startsWith("state:")).toBe(true);
    expect(id.slice("state:".length)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computeVisualFingerprint", () => {
  it("returns a `vp:`-prefixed sha256 hex string", () => {
    const fp = computeVisualFingerprint(payloadWith());
    expect(fp.startsWith("vp:")).toBe(true);
    expect(fp.slice("vp:".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same payload", () => {
    const p = payloadWith();
    expect(computeVisualFingerprint(p)).toBe(computeVisualFingerprint(p));
  });

  it("changes when an element's visibility/pressed/open/expanded changes", () => {
    const a = payloadWith({
      elements: {
        "ax:1": {
          axId: "ax:1", rect: { x: 0, y: 0, w: 1, h: 1 },
          visibility: "visible", zIndex: 0, open: null, expanded: null,
          selected: null, checked: null, pressed: null, busy: null,
          ariaStates: {}, visualNodeId: null,
        },
      },
    });
    const b = payloadWith({
      elements: {
        "ax:1": {
          axId: "ax:1", rect: { x: 0, y: 0, w: 1, h: 1 },
          visibility: "visible", zIndex: 0, open: null, expanded: null,
          selected: null, checked: null, pressed: true, busy: null,  // pressed changed
          ariaStates: {}, visualNodeId: null,
        },
      },
    });
    expect(computeVisualFingerprint(a)).not.toBe(computeVisualFingerprint(b));
  });

  it("changes when an open dialog appears", () => {
    const a = payloadWith({ openDialogIds: [] });
    const b = payloadWith({ openDialogIds: ["dlg:1"] });
    expect(computeVisualFingerprint(a)).not.toBe(computeVisualFingerprint(b));
  });
});

describe("buildStatePayload", () => {
  it("fills in the pageId and route fields from args", () => {
    const p = buildStatePayload({
      pageId: "page:https://x/",
      route: "https://x/",
      auth: ANON,
      network: NO_NETWORK,
      elements: {},
      // PR-8g T1: State-level focus pointer.
      focusedAxId: null,
      openDialogIds: [],
      openPopoverIds: [],
      expandedRegionAxIds: [],
      viewport: { w: 1, h: 1, dpr: 1, scrollX: 0, scrollY: 0 },
    });
    expect(p.pageId).toBe("page:https://x/");
    expect(p.route).toBe("https://x/");
    expect(p.auth).toEqual(ANON);
    expect(p.network).toEqual(NO_NETWORK);
  });

  it("defaults conditionalMarkers to {} when omitted", () => {
    const p = buildStatePayload({
      pageId: "p", route: "r", auth: ANON, network: NO_NETWORK,
      elements: {}, focusedAxId: null,
      openDialogIds: [], openPopoverIds: [],
      expandedRegionAxIds: [], viewport: { w: 1, h: 1, dpr: 1, scrollX: 0, scrollY: 0 },
    });
    expect(p.conditionalMarkers).toEqual({});
  });
});
