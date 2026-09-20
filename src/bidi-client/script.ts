/**
 * Typed wrapper for the BiDi script module.
 *
 * Per the env-report: Firefox 154 supports evaluate and callFunction.
 * addPreloadScript is unverified; v1 re-injects via callFunction post-navigation
 * (see plan section 8.1).
 */
import type { BiDiTransport } from "./transport.js";

/**
 * RemoteValue — the WebDriver-BiDi wire type for script results.
 *
 * Spec-accurate. Two container-level behaviors verified against Firefox 154
 * on the 2026-09-16 Evidence Ledger runs (ED-10 §6):
 *
 * 1. **internalId back-references** (the root cause of the first ledger
 *    failure): when the SAME object reference appears more than once in a
 *    payload, the first occurrence serializes with `value` + an
 *    `internalId`, and every later occurrence serializes as a value-less
 *    back-reference (`{ type: "object", internalId: "…" }`) — no `value`,
 *    no `handle`. `internalId` is therefore OPTIONAL on container types,
 *    and clients must correlate back-references to the first occurrence.
 *
 * 2. **Depth truncation**: when a payload nests deeper than the negotiated
 *    `serializationOptions.maxObjectDepth`, containers arrive handle-only
 *    (`{ type: "object", handle: "h0" }`) with no `value`. `value` is
 *    therefore OPTIONAL, and containers may carry a `handle` reference.
 */
export type RemoteValue =
  | { type: "undefined" }
  | { type: "null" }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "bigint"; value: string }
  | { type: "array"; value?: RemoteValue[]; handle?: string; internalId?: string }
  | { type: "object"; value?: Array<[string, RemoteValue]>; handle?: string; internalId?: string }
  | { type: "symbol"; value: string }
  | { type: "function"; value: string }
  | { type: "node"; sharedId: string; handle?: string };

/**
 * Serialization depth requested on every script call (ED-10 §6).
 *
 * Deep payloads (the VI-02 visual walker nests far past the default) arrive
 * handle-only when they exceed the remote end's default object depth. Raising
 * the depth explicitly makes deep payloads arrive whole. 1000 is effectively
 * unbounded for in-page walker payloads while remaining a valid finite number
 * for every BiDi implementation.
 *
 * NOTE (2026-09-16 probe 2b): depth was NOT the cause of the first ledger
 * failure — that was an internalId back-reference (see the RemoteValue doc).
 * The explicit depth remains correct defense against genuine truncation.
 */
const MAX_OBJECT_DEPTH = 1000;

export interface ScriptTarget {
  context: string;
  /** Optional sandbox to evaluate in (default: target context's realm) */
  sandbox?: string;
}

export interface ScriptEvaluateResult {
  realm: string;
  type: "success" | "exception";
  result?: RemoteValue;
  exceptionDetails?: { text: string; columnNumber: number; lineNumber: number; stackTrace?: string };
}

export interface ScriptCallFunctionResult extends ScriptEvaluateResult {}

export class ScriptApi {
  constructor(private transport: BiDiTransport) {}

  /**
   * Evaluate an expression in the target context. Returns the unwrapped JS value
   * or throws on exception. Always sends `resultOwnership: "root"` so handles
   * don't leak.
   */
  async evaluate<T = unknown>(
    target: ScriptTarget,
    expression: string,
    options: { awaitPromise?: boolean } = {},
  ): Promise<T> {
    const r = await this.transport.send<ScriptEvaluateResult>("script.evaluate", {
      expression,
      target,
      awaitPromise: options.awaitPromise ?? false,
      resultOwnership: "root",
      // ED-10 §6 defect 1: never let the remote end truncate the payload.
      serializationOptions: { maxObjectDepth: MAX_OBJECT_DEPTH },
    });
    return unwrap(r) as T;
  }

  /**
   * Call a function in the target context. The function is serialized via
   * `functionDeclaration` — it must be a self-contained arrow/function with no
   * closures over outer JS (BiDi deserializes it in the target realm).
   */
  async callFunction<T = unknown>(
    target: ScriptTarget,
    functionDeclaration: string,
    args: unknown[] = [],
    options: { awaitPromise?: boolean } = {},
  ): Promise<T> {
    const r = await this.transport.send<ScriptCallFunctionResult>("script.callFunction", {
      functionDeclaration,
      arguments: args.map(serializeArg),
      target,
      awaitPromise: options.awaitPromise ?? false,
      resultOwnership: "root",
      // ED-10 §6 defect 1: never let the remote end truncate the payload.
      serializationOptions: { maxObjectDepth: MAX_OBJECT_DEPTH },
    });
    return unwrap(r) as T;
  }
}

/** Serialize a JS value to a BiDi RemoteValue for use as a callFunction argument. */
function serializeArg(v: unknown): RemoteValue {
  if (v === undefined) return { type: "undefined" };
  if (v === null) return { type: "null" };
  if (typeof v === "string") return { type: "string", value: v };
  if (typeof v === "number") return { type: "number", value: v };
  if (typeof v === "boolean") return { type: "boolean", value: v };
  if (typeof v === "bigint") return { type: "bigint", value: v.toString() };
  if (Array.isArray(v)) return { type: "array", value: v.map(serializeArg) };
  if (typeof v === "object") {
    return { type: "object", value: Object.entries(v as object).map(([k, vv]) => [k, serializeArg(vv)]) };
  }
  throw new Error(`cannot serialize ${typeof v} as BiDi argument`);
}

/** Unwrap a BiDi script result to a plain JS value, throwing on exception. */
function unwrap(r: ScriptEvaluateResult): unknown {
  if (r.type === "exception") {
    const detail = r.exceptionDetails;
    const msg = detail ? `${detail.text} @ ${detail.lineNumber}:${detail.columnNumber}` : "script exception";
    const err = new Error(`script.${msg}`);
    if (detail?.stackTrace) (err as any).stack = detail.stackTrace;
    throw err;
  }
  if (!r.result) return undefined;
  return remoteToJs(r.result);
}

function remoteToJs(v: RemoteValue): unknown {
  // internalId → deserialized value. Per the BiDi spec, the first occurrence
  // of a repeated object carries `internalId`; later occurrences are value-less
  // back-references that must resolve to the first occurrence's value. The map
  // is recorded BEFORE recursing so true cycles also resolve.
  return remoteToJsWithRefs(v, new Map());
}

function remoteToJsWithRefs(v: RemoteValue, refs: Map<string, unknown>): unknown {
  switch (v.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "string": return v.value;
    case "number": return v.value;
    case "boolean": return v.value;
    case "bigint": return BigInt(v.value);
    case "array": {
      if (!v.value) {
        if (v.internalId && refs.has(v.internalId)) return refs.get(v.internalId);
        throw truncatedRemoteValue(v);
      }
      const arr = v.value.map((x) => remoteToJsWithRefs(x, refs));
      if (v.internalId) refs.set(v.internalId, arr);
      return arr;
    }
    case "object": {
      if (!v.value) {
        if (v.internalId && refs.has(v.internalId)) return refs.get(v.internalId);
        throw truncatedRemoteValue(v);
      }
      const o: Record<string, unknown> = {};
      if (v.internalId) refs.set(v.internalId, o);
      for (const [k, vv] of v.value) o[k] = remoteToJsWithRefs(vv, refs);
      return o;
    }
    default: return undefined; // symbol/function/node: not useful in JS
  }
}

/**
 * A well-formed BiDi response delivered a handle-only RemoteValue — a
 * truncated array/object with no `value` payload (ED-10 §6 defect 1).
 * Never crash with a bare TypeError here: name the defect so the next
 * person who hits it (a payload deeper than MAX_OBJECT_DEPTH, or an
 * endpoint that ignored serializationOptions) gets an actionable message
 * instead of `v.value is not iterable`. This is exactly the silent-looking
 * failure that took down the visual extractor on all 6 pages of the first
 * real-target Evidence Ledger run (2026-09-16).
 */
function truncatedRemoteValue(v: RemoteValue): Error {
  const handle = (v as { handle?: string }).handle;
  const internalId = (v as { internalId?: string }).internalId;
  return new Error(
    `BiDi deserialization hit a value-less "${v.type}" RemoteValue` +
    (internalId ? ` (internalId: ${internalId})` : "") +
    (handle ? ` (handle: ${handle})` : "") +
    `. Two known causes: (1) a repeated object reference serialized as an ` +
    `internalId back-reference whose first occurrence is not part of this ` +
    `payload — the client resolves back-references it has already seen; ` +
    `this one was never seen. (2) The response exceeded the negotiated ` +
    `serialization depth (serializationOptions.maxObjectDepth=${MAX_OBJECT_DEPTH}) ` +
    `— the remote end ignored serializationOptions, or the in-page walker ` +
    `nests deeper than ${MAX_OBJECT_DEPTH}. Flatten the walker payload ` +
    `(no shared object references), or return JSON.stringify(...) instead.`,
  );
}
