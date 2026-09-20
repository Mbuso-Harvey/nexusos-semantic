/**
 * Unit tests for the Stage 8 behavior extractor. We mock Page.script.callFunction
 * so the test runs without a real BiDi session. The mock's callFunction
 * returns a combined `{ declared, elements }` shape, matching what the
 * real page-side walker produces.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Graph } from "../../src/graph/graph.js";
import {
  runBehaviorExtractor,
  toDeclaredCapability,
  synthesizeCapability,
  buildSelector,
  slugify,
  type ElementHint,
  type DeclaredCapabilityShape,
} from "../../src/extract-behavior/behavior.js";
import type { Page } from "../../src/bidi-client/page.js";
import type { PageNode } from "../../src/graph/types.js";
import { tierForCapability } from "../../src/graph/security.js";

const PAGE_NODE: PageNode = {
  id: "page:https://example.com/",
  type: "page",
  url: "https://example.com/",
  title: "Test",
  discoveredVia: ["seed"],
  loadStatus: "complete",
  axTreeRef: { rootAxId: "ax:root", provenance: "bidi:script.callFunction" },
  viewport: { w: 1280, h: 800, dpr: 1 },
  tokensOverride: null,
  screenshotRef: null,
  canonicalUrl: "https://example.com/",
  crawledAt: new Date(0).toISOString(), parentPageId: null,
};

function makeMockPage(declared: DeclaredCapabilityShape[] | null, elements: ElementHint[]): Page {
  return {
    target: { context: "ctx" },
    script: {
      // The real callFunction unwraps the BiDi RemoteValue to a plain JS value.
      // Our walker returns `{ declared, elements }`; the mock just hands that back.
      callFunction: vi.fn(async (_target: any, _fn: string, _args: any) => ({ declared, elements })),
      evaluate: vi.fn(),
    },
  } as unknown as Page;
}

describe("slugify", () => {
  it("lowercases, replaces non-alphanumerics with hyphens, trims and caps at 32 chars", () => {
    expect(slugify("Create New Ticket")).toBe("create-new-ticket");
    expect(slugify("  Delete!! Account?? ")).toBe("delete-account");
    expect(slugify("A".repeat(60))).toHaveLength(32);
    expect(slugify("")).toBe("");
  });
});

describe("synthesizeCapability", () => {
  it("builds the right inputSchema for a textbox and a PROPOSE tier", () => {
    const hint: ElementHint = {
      axId: "ax:n1", role: "textbox", name: "Email",
      tagName: "input", id: null, hasDataCap: false, inputKeys: ["value"],
    };
    const cap = synthesizeCapability(hint, PAGE_NODE);
    expect(cap.inputSchema).toEqual({ value: { type: "string" } });
    expect(cap.security).toBe("PROPOSE");
    expect(cap.source).toBe("fallback");
    expect(cap.provenance).toBe("aria:fallback-catalog");
    expect(cap.binding.kind).toBe("ax-node");
    expect(cap.binding.axId).toBe("ax:n1");
    expect(cap.pageId).toBe(PAGE_NODE.id);
    expect(cap.name).toBe("email");
    expect(cap.description).toBe("Email");
  });

  it("builds a boolean inputSchema for a checkbox", () => {
    const hint: ElementHint = {
      axId: "ax:n2", role: "checkbox", name: "Remember me",
      tagName: "input", id: null, hasDataCap: false, inputKeys: ["checked"],
    };
    const cap = synthesizeCapability(hint, PAGE_NODE);
    expect(cap.inputSchema).toEqual({ checked: { type: "boolean" } });
    // The security module's first rule promotes any non-button/non-link
    // role with inputKeys to PROPOSE; that's what the spec requires
    // (we pass Object.keys(inputSchema) as inputKeys). The role-only
    // rule is only reached when inputKeys is empty.
    expect(cap.security).toBe("PROPOSE");
  });

  it("builds an enum inputSchema for a select with options", () => {
    const hint: ElementHint = {
      axId: "ax:n3", role: "combobox", name: "Severity",
      tagName: "select", id: null, hasDataCap: false,
      inputKeys: ["value"], optionValues: ["low", "medium", "high"],
    };
    const cap = synthesizeCapability(hint, PAGE_NODE);
    expect(cap.inputSchema).toEqual({ value: { type: "string", enum: ["low", "medium", "high"] } });
  });

  it("promotes a destructive button to CONFIRM via tierForCapability", () => {
    // Stage-8 explicitly defers to the security module.
    const hint: ElementHint = {
      axId: "ax:n4", role: "button", name: "Delete account",
      tagName: "button", id: "btn-del", hasDataCap: false, inputKeys: [],
    };
    const cap = synthesizeCapability(hint, PAGE_NODE);
    expect(cap.security).toBe("CONFIRM");
    // Sanity: the security module classifies it independently.
    expect(tierForCapability({ role: "button", name: "Delete account", inputKeys: [] })).toBe("CONFIRM");
  });
});

describe("toDeclaredCapability", () => {
  it("uses source webmcp and declared provenance", () => {
    const d: DeclaredCapabilityShape = {
      name: "create_ticket",
      description: "Create a new support ticket.",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      outputSchema: { type: "object", properties: { ticketId: { type: "string" } } },
      binding: { kind: "ax-node", axId: "ax:btn-new-ticket" },
      security: "EXECUTE",
    };
    const cap = toDeclaredCapability(d, PAGE_NODE);
    expect(cap.source).toBe("webmcp");
    expect(cap.provenance).toBe("declared:webmcp.json");
    expect(cap.security).toBe("EXECUTE");
    expect(cap.binding.axId).toBe("ax:btn-new-ticket");
    expect(cap.inputSchema.properties).toEqual({ title: { type: "string" } });
    expect(cap.pageId).toBe(PAGE_NODE.id);
  });

  it("falls back to tierForCapability when security is missing", () => {
    // The security regex requires a word boundary after the verb — "delete
    // workspace" (with a space) matches. Underscore-separated names do
    // not because "_" is a word character; that's a pre-existing property
    // of the security module.
    const d: DeclaredCapabilityShape = {
      name: "delete workspace",
      inputSchema: { type: "object" },
    };
    const cap = toDeclaredCapability(d, PAGE_NODE);
    expect(cap.security).toBe("CONFIRM");
  });
});

describe("buildSelector", () => {
  it("prefers an explicit id", () => {
    expect(buildSelector({
      axId: "ax:1", role: "button", name: "x", tagName: "button",
      id: "btn-x", hasDataCap: false, inputKeys: [],
    })).toBe("#btn-x");
  });

  it("falls back to tag + data-cap when no id is set", () => {
    expect(buildSelector({
      axId: "ax:1", role: "button", name: "x", tagName: "button",
      id: null, hasDataCap: true, inputKeys: [],
    })).toBe("button[data-cap]");
  });

  it("walks up to the first ancestor with an id", () => {
    expect(buildSelector({
      axId: "ax:1", role: "button", name: "x", tagName: "button",
      id: null, hasDataCap: false, inputKeys: [],
      ancestors: [
        { id: null, role: "group", tagName: "div" },
        { id: "toolbar", role: null, tagName: "div" },
      ],
    })).toBe("#toolbar > button");
  });

  it("walks up to the first ancestor with a role and includes nth-of-type", () => {
    expect(buildSelector({
      axId: "ax:1", role: "button", name: "x", tagName: "button",
      id: null, hasDataCap: false, inputKeys: [],
      ancestors: [
        { id: null, role: "toolbar", tagName: "div", index: 0 },
      ],
    })).toBe("div[role=\"toolbar\"]:nth-of-type(1) > button");
  });
});

describe("runBehaviorExtractor — full pipeline", () => {
  let graph: Graph;

  beforeEach(() => {
    graph = new Graph();
    graph.upsertPage(PAGE_NODE);
  });

  it("upserts a declared capability with source webmcp and synthesizes fallbacks for the rest", async () => {
    const declared: DeclaredCapabilityShape[] = [
      { name: "create_ticket", description: "Create a support ticket", inputSchema: { type: "object" } },
    ];
    const elements: ElementHint[] = [
      // A real button — gets synthesized
      { axId: "ax:n1", role: "button", name: "Save draft", tagName: "button", id: "btn-save", hasDataCap: false, inputKeys: [] },
      // A textbox — synthesized, PROPOSE tier
      { axId: "ax:n2", role: "textbox", name: "Email", tagName: "input", id: null, hasDataCap: false, inputKeys: ["value"] },
      // A checkbox — synthesized, EXECUTE tier
      { axId: "ax:n3", role: "checkbox", name: "Remember me", tagName: "input", id: null, hasDataCap: false, inputKeys: ["checked"] },
      // A select with options — synthesized, inputSchema has enum
      { axId: "ax:n4", role: "combobox", name: "Severity", tagName: "select", id: null, hasDataCap: false, inputKeys: ["value"], optionValues: ["low", "medium", "high"] },
      // A destructive button — synthesized, CONFIRM tier
      { axId: "ax:n5", role: "button", name: "Delete account", tagName: "button", id: null, hasDataCap: false, inputKeys: [] },
      // A link — synthesized, EXECUTE tier
      { axId: "ax:n6", role: "link", name: "Read more", tagName: "a", id: null, hasDataCap: false, inputKeys: [] },
    ];
    const page = makeMockPage(declared, elements);
    const log = vi.fn();

    const r = await runBehaviorExtractor({
      graph, page, pageNode: PAGE_NODE, log,
    });

    expect(r.declared).toBe(1);
    // 6 elements, none share a slug with the declared "create_ticket" name,
    // so all 6 get synthesized fallbacks.
    expect(r.synthesized).toBe(6);
    expect(r.total).toBe(7);

    // Declared: source webmcp.
    const declaredCaps = [...graph.capabilities()].filter((c) => c.source === "webmcp");
    expect(declaredCaps).toHaveLength(1);
    expect(declaredCaps[0]!.name).toBe("create_ticket");
    expect(declaredCaps[0]!.provenance).toBe("declared:webmcp.json");

    // Fallback: synthesized for the others.
    const fallbacks = [...graph.capabilities()].filter((c) => c.source === "fallback");
    expect(fallbacks).toHaveLength(6);

    const byAx = new Map(fallbacks.map((c) => [c.binding.axId, c]));
    // Name is always a slug of the accessible name (per spec), not the
    // element's id. The id IS used for the selector hook.
    expect(byAx.get("ax:n1")!.name).toBe("save-draft");
    expect(byAx.get("ax:n1")!.binding.selector).toBe("#btn-save");
    expect(byAx.get("ax:n2")!.inputSchema).toEqual({ value: { type: "string" } });
    expect(byAx.get("ax:n2")!.security).toBe("PROPOSE");
    expect(byAx.get("ax:n3")!.inputSchema).toEqual({ checked: { type: "boolean" } });
    // See the synthesizeCapability test for why this is PROPOSE not EXECUTE.
    expect(byAx.get("ax:n3")!.security).toBe("PROPOSE");
    expect(byAx.get("ax:n4")!.inputSchema).toEqual({ value: { type: "string", enum: ["low", "medium", "high"] } });
    // Destructive-verb promotion: button named "Delete account" -> CONFIRM.
    expect(byAx.get("ax:n5")!.security).toBe("CONFIRM");
    // Link with no inputs -> EXECUTE.
    expect(byAx.get("ax:n6")!.security).toBe("EXECUTE");

    // The mock's callFunction should have been called exactly once with
    // the pageNodeId as its sole arg.
    expect((page.script.callFunction as any).mock.calls).toHaveLength(1);
    expect((page.script.callFunction as any).mock.calls[0][2]).toEqual([PAGE_NODE.id]);

    // One-line summary was logged.
    expect(log).toHaveBeenCalled();
    const msg = log.mock.calls[0]![0] as string;
    expect(msg).toMatch(/\[behavior\] declared=1 synthesized=6 total=7/);
  });

  it("treats a null declared set as 'no /webmcp.json' and falls back entirely", async () => {
    const elements: ElementHint[] = [
      { axId: "ax:n1", role: "button", name: "OK", tagName: "button", id: null, hasDataCap: false, inputKeys: [] },
    ];
    const page = makeMockPage(null, elements);
    const r = await runBehaviorExtractor({
      graph, page, pageNode: PAGE_NODE, log: () => undefined,
    });
    expect(r.declared).toBe(0);
    expect(r.synthesized).toBe(1);
    expect([...graph.capabilities()].every((c) => c.source === "fallback")).toBe(true);
  });

  it("the declared capability wins when its name matches a synthesized one (same slug)", async () => {
    const declared: DeclaredCapabilityShape[] = [
      { name: "delete-account", description: "Declared delete", inputSchema: {} },
    ];
    const elements: ElementHint[] = [
      // Accessible name "Delete account" -> slug "delete-account" -> collides
      { axId: "ax:n1", role: "button", name: "Delete account", tagName: "button", id: null, hasDataCap: false, inputKeys: [] },
      // A non-colliding element
      { axId: "ax:n2", role: "link", name: "Help", tagName: "a", id: null, hasDataCap: false, inputKeys: [] },
    ];
    const page = makeMockPage(declared, elements);
    const r = await runBehaviorExtractor({
      graph, page, pageNode: PAGE_NODE, log: () => undefined,
    });
    expect(r.declared).toBe(1);
    expect(r.synthesized).toBe(1); // 'Help' is the only non-collision
    const matching = [...graph.capabilities()].find((c) => c.name === "delete-account");
    expect(matching).toBeDefined();
    expect(matching!.source).toBe("webmcp");
    expect(matching!.description).toBe("Declared delete");
  });

  it("capabilities are retrievable by page", async () => {
    const page = makeMockPage([], [
      { axId: "ax:n1", role: "button", name: "OK", tagName: "button", id: null, hasDataCap: false, inputKeys: [] },
    ]);
    await runBehaviorExtractor({ graph, page, pageNode: PAGE_NODE, log: () => undefined });
    expect(graph.capabilitiesByPage(PAGE_NODE.id)).toHaveLength(1);
  });
});
