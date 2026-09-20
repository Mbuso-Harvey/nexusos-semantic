/**
 * Unit tests for the ScriptApi wrapper and the RemoteValue converter
 * (ED-10 Â§6 â€” regression locks for defects 1 and 2).
 *
 * Defect 2 (2026-09-16, the REAL root cause of the first ledger failure):
 * the first real-target run (verification/runs/demo-saas/2026-09-16T16-28-â€¦)
 * failed the visual extractor on all 6 pages while structural/declared/observed
 * succeeded on the same graph. Probe 2b (wire tap over the exact production
 * sequence) captured the cause: the in-page walker placed the SAME object
 * reference at multiple payload placements (rect / boxModel.borderBox /
 * renderBounds.transformed â€” 2 back-references per element x 44 elements =
 * the 88 value-less containers the tap measured). WebDriver BiDi serializes a
 * repeated reference as a value-less {type:"object",internalId} back-reference
 * to the first occurrence. remoteToJs iterated the missing field. The unit
 * suite never caught it because mocked transports return fully-materialized
 * trees â€” the mock-contract drift the audit predicted.
 *
 * Defect 1 (depth truncation, secondary): payloads nesting deeper than the
 * negotiated maxObjectDepth arrive handle-only ({type:"object",handle}).
 *
 * The fixes are locked by the tests below:
 *   1. Every script call negotiates serializationOptions.maxObjectDepth
 *      so deep payloads arrive whole (evaluate + callFunction).
 *   2. remoteToJs resolves internalId back-references (repeated references
 *      AND true cycles) to the first occurrence's deserialized value.
 *   3. remoteToJs unwraps deeply nested payloads faithfully.
 *   4. If truncation or an unresolvable back-reference ever recurs,
 *      remoteToJs throws a loud, self-diagnosing error naming the defect â€”
 *      never a bare TypeError from deep inside the converter.
 *   5. The walker no longer shares object references (visual.ts clones at
 *      every payload placement; locked by the production-path replay in
 *      the Evidence Ledger run, which must report zero extractor failures).
 */
import { describe, it, expect, vi } from "vitest";
import { ScriptApi, type RemoteValue, type ScriptTarget } from "../../src/bidi-client/script.js";
import type { BiDiTransport } from "../../src/bidi-client/transport.js";

/** Records every send; responds via `respond` or a plain undefined success. */
function makeMockTransport(respond?: (method: string, params: any) => unknown) {
  const sent: Array<{ method: string; params: any }> = [];
  const transport = {
    send: vi.fn(async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (respond) return respond(method, params);
      return { realm: "r0", type: "success", result: { type: "undefined" } };
    }),
  } as unknown as BiDiTransport;
  return { transport, sent };
}

/**
 * First recorded send, asserted to exist. Satisfies noUncheckedIndexedAccess
 * without non-null assertions, and fails with a named message if the transport
 * was never called (instead of a bare undefined dereference).
 */
function firstSend(sent: Array<{ method: string; params: any }>) {
  const first = sent[0];
  if (!first) throw new Error("expected the transport to have received a send");
  return first;
}

const target: ScriptTarget = { context: "ctx-1" };

describe("ScriptApi serializationOptions (defect 1, layer 1)", () => {
  it("evaluate sends serializationOptions.maxObjectDepth=1000 and resultOwnership root", async () => {
    const { transport, sent } = makeMockTransport();
    const api = new ScriptApi(transport);
    await api.evaluate(target, "1 + 1");
    expect(sent.length).toBe(1);
    expect(firstSend(sent).method).toBe("script.evaluate");
    expect(firstSend(sent).params.resultOwnership).toBe("root");
    expect(firstSend(sent).params.serializationOptions).toEqual({ maxObjectDepth: 1000 });
  });

  it("callFunction sends serializationOptions.maxObjectDepth=1000", async () => {
    const { transport, sent } = makeMockTransport();
    const api = new ScriptApi(transport);
    await api.callFunction(target, "() => 1", []);
    expect(firstSend(sent).method).toBe("script.callFunction");
    expect(firstSend(sent).params.functionDeclaration).toBe("() => 1");
    expect(firstSend(sent).params.serializationOptions).toEqual({ maxObjectDepth: 1000 });
  });

  it("callFunction serializes JS args to RemoteValues (deep equality)", async () => {
    const { transport, sent } = makeMockTransport();
    const api = new ScriptApi(transport);
    await api.callFunction(target, "(arg) => arg", [{ a: 1, nested: [true, "s", null] }]);
    expect(firstSend(sent).params.arguments).toEqual([
      {
        type: "object",
        value: [
          ["a", { type: "number", value: 1 }],
          ["nested", { type: "array", value: [{ type: "boolean", value: true }, { type: "string", value: "s" }, { type: "null" }] }],
        ],
      },
    ]);
  });
});

describe("ScriptApi remoteToJs (defect 1, layer 2)", () => {
  it("unwraps a deeply nested object/array/string/number payload faithfully", async () => {
    const deep: RemoteValue = {
      type: "object",
      value: [
        ["elements", {
          type: "array",
          value: [
            { type: "object", value: [
              ["role", { type: "string", value: "button" }],
              ["boxModel", { type: "object", value: [
                ["content", { type: "object", value: [["x", { type: "number", value: 10 }]] }],
              ] }],
            ] },
          ],
        }],
      ],
    };
    const { transport } = makeMockTransport(() => ({ realm: "r0", type: "success", result: deep }));
    const api = new ScriptApi(transport);
    const v = await api.evaluate<unknown>(target, "payload");
    expect(v).toEqual({ elements: [{ role: "button", boxModel: { content: { x: 10 } } }] });
  });

  it("unwraps bigint and null leaves", async () => {
    const { transport } = makeMockTransport(() => ({
      realm: "r0",
      type: "success",
      result: { type: "object", value: [["n", { type: "bigint", value: "9007199254740993" }], ["z", { type: "null" }]] },
    }));
    const api = new ScriptApi(transport);
    const v = await api.evaluate<any>(target, "x");
    expect(v.n).toBe(9007199254740993n);
    expect(v.z).toBeNull();
  });
});

describe("ScriptApi truncation backstop (defect 1, layer 3)", () => {
  it("handle-only object RemoteValue throws the loud, self-diagnosing error — not a TypeError", async () => {
    const handleOnly: RemoteValue = { type: "object", handle: "h0" };
    const { transport } = makeMockTransport(() => ({ realm: "r0", type: "success", result: handleOnly }));
    const api = new ScriptApi(transport);
    let caught: unknown;
    try { await api.evaluate(target, "x"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    const msg = (caught as Error).message;
    expect(msg).toContain('BiDi deserialization hit a value-less "object" RemoteValue');
    expect(msg).toContain("(handle: h0)");
    expect(msg).toContain("maxObjectDepth=1000");
  });

  it("handle-only array RemoteValue throws the loud error too", async () => {
    const handleOnly: RemoteValue = { type: "array", handle: "h9" };
    const { transport } = makeMockTransport(() => ({ realm: "r0", type: "success", result: handleOnly }));
    const api = new ScriptApi(transport);
    await expect(api.evaluate(target, "x")).rejects.toThrowError(/BiDi deserialization hit a value-less "array" RemoteValue/);
  });

  it("a remote script exception surfaces as a script.* error with position", async () => {
    const { transport } = makeMockTransport(() => ({
      realm: "r0",
      type: "exception",
      exceptionDetails: { text: "boom", lineNumber: 3, columnNumber: 7 },
    }));
    const api = new ScriptApi(transport);
    await expect(api.evaluate(target, "x")).rejects.toThrowError(/script\.boom @ 3:7/);
  });
});

describe("ScriptApi internalId back-references (defect 2 â€” the real 2026-09-16 root cause)", () => {
  it("resolves a repeated object reference: later value-less occurrences return the first occurrence's value", async () => {
    // Exactly the wire shape probe 2b captured on the production path: the
    // walker's boxModel.borderBox was serialized as `rect` (first occurrence,
    // internalId assigned + full value) and again as a value-less
    // back-reference inside boxModel and renderBounds.transformed.
    const repeated: RemoteValue = {
      type: "object",
      value: [
        ["rect", { type: "object", internalId: "i-1", value: [["x", { type: "number", value: 1 }]] }],
        ["boxModel", { type: "object", value: [["borderBox", { type: "object", internalId: "i-1" }]] }],
        ["renderBounds", { type: "object", value: [["transformed", { type: "object", internalId: "i-1" }]] }],
      ],
    };
    const { transport } = makeMockTransport(() => ({ realm: "r0", type: "success", result: repeated }));
    const api = new ScriptApi(transport);
    const v = await api.evaluate<any>(target, "payload");
    expect(v.rect).toEqual({ x: 1 });
    expect(v.boxModel.borderBox).toBe(v.rect); // same deserialized object reference
    expect(v.renderBounds.transformed).toBe(v.rect); // same deserialized object reference
  });

  it("resolves a true cycle (self-referencing object) without throwing", async () => {
    // Per spec the internalId is recorded on the first occurrence BEFORE its
    // value is deserialized, so a self-reference resolves to the object itself.
    const cycle: RemoteValue = {
      type: "object",
      internalId: "i-root",
      value: [
        ["name", { type: "string", value: "root" }],
        ["self", { type: "object", internalId: "i-root" }],
      ],
    };
    const { transport } = makeMockTransport(() => ({ realm: "r0", type: "success", result: cycle }));
    const api = new ScriptApi(transport);
    const v = await api.evaluate<any>(target, "payload");
    expect(v.name).toBe("root");
    expect(v.self).toBe(v);
  });

  it("a value-less back-reference whose first occurrence was never seen still throws the loud, named error", async () => {
    const orphan: RemoteValue = {
      type: "object",
      value: [["x", { type: "object", internalId: "i-never-seen" }]],
    };
    const { transport } = makeMockTransport(() => ({ realm: "r0", type: "success", result: orphan }));
    const api = new ScriptApi(transport);
    const err = await api.evaluate(target, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('BiDi deserialization hit a value-less "object" RemoteValue');
    expect((err as Error).message).toContain("internalId: i-never-seen");
    expect((err as Error).message).toContain("repeated object reference");
  });
});