/**
 * Unit tests for the security tier classifier and decide() — this is the
 * safety layer the agent depends on, so it gets its own test file.
 */
import { describe, it, expect } from "vitest";
import { tierForCapability, decide, maxTier, tierRank } from "../../src/graph/security.js";

describe("tierForCapability", () => {
  it("promotes destructive verbs to CONFIRM", () => {
    expect(tierForCapability({ role: "button", name: "Delete account", inputKeys: [] })).toBe("CONFIRM");
    expect(tierForCapability({ role: "button", name: "Remove member", inputKeys: [] })).toBe("CONFIRM");
    expect(tierForCapability({ role: "button", name: "Sign out", inputKeys: [] })).toBe("CONFIRM");
  });

  it("promotes billing/payment/production keywords to CONFIRM", () => {
    expect(tierForCapability({ role: "button", name: "Update payment method", inputKeys: [] })).toBe("CONFIRM");
    expect(tierForCapability({ role: "button", name: "Confirm subscription", inputKeys: [] })).toBe("CONFIRM");
    expect(tierForCapability({ role: "button", name: "Push to production", inputKeys: [] })).toBe("CONFIRM");
    expect(tierForCapability({ role: "button", name: "Transfer ownership", inputKeys: [] })).toBe("CONFIRM");
  });

  it("promotes text inputs to PROPOSE", () => {
    expect(tierForCapability({ role: "textbox", name: "Email", inputKeys: [] })).toBe("PROPOSE");
    expect(tierForCapability({ role: "searchbox", name: "Search", inputKeys: [] })).toBe("PROPOSE");
  });

  it("promotes a non-button role with inputs to PROPOSE (state-changing input)", () => {
    // The plan's static rules only promote non-button/link roles that have
    // inputKeys. A button with inputs is still EXECUTE in v1.
    expect(tierForCapability({ role: "textbox", name: "Save query", inputKeys: ["q"] })).toBe("PROPOSE");
  });

  it("puts click-only buttons at EXECUTE", () => {
    expect(tierForCapability({ role: "button", name: "Open", inputKeys: [] })).toBe("EXECUTE");
    expect(tierForCapability({ role: "link", name: "Read more", inputKeys: [] })).toBe("EXECUTE");
  });

  it("falls back to READ for non-interactive roles", () => {
    expect(tierForCapability({ role: "heading", name: "Welcome", inputKeys: [] })).toBe("READ");
  });
});

describe("decide", () => {
  it("refuses DISCOVER capabilities outright", () => {
    const d = decide({ tier: "DISCOVER", capabilityId: "cap:x", role: "button", name: "x", confirm: true });
    expect(d.ok).toBe(false);
    expect(d.requireConfirm).toBe(false);
  });

  it("requires confirm for CONFIRM when not confirmed", () => {
    const d = decide({ tier: "CONFIRM", capabilityId: "cap:del", role: "button", name: "Delete", confirm: false });
    expect(d.ok).toBe(false);
    expect(d.requireConfirm).toBe(true);
    expect(d.preview?.tier).toBe("CONFIRM");
  });

  it("admits CONFIRM when confirm:true is passed", () => {
    const d = decide({ tier: "CONFIRM", capabilityId: "cap:del", role: "button", name: "Delete", confirm: true });
    expect(d.ok).toBe(true);
  });
});

describe("maxTier / tierRank", () => {
  it("maxTier returns the more restrictive of the two", () => {
    expect(maxTier("DISCOVER", "EXECUTE")).toBe("EXECUTE");
    expect(maxTier("CONFIRM", "READ")).toBe("CONFIRM");
    expect(maxTier("PROPOSE", "PROPOSE")).toBe("PROPOSE");
  });

  it("tierRank is monotonic", () => {
    expect(tierRank("DISCOVER")).toBeLessThan(tierRank("READ"));
    expect(tierRank("READ")).toBeLessThan(tierRank("PROPOSE"));
    expect(tierRank("PROPOSE")).toBeLessThan(tierRank("EXECUTE"));
    expect(tierRank("EXECUTE")).toBeLessThan(tierRank("CONFIRM"));
  });
});
