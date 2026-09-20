import { describe, it, expect } from "vitest";
import { PostureManager, SecurityPosture, hashScope, generateAuthorizationId } from "../../src/security/posture.js";

describe("PostureManager", () => {
  it("starts in AUDIT and allows read", () => {
    const pm = new PostureManager();
    expect(pm.posture).toBe(SecurityPosture.AUDIT);
    expect(pm.checkOperation({ operation: "graph_query", substrate: "web", target: "https://x.com", impact: "read" }).allowed).toBe(true);
  });

  it("blocks write in AUDIT", () => {
    const pm = new PostureManager();
    expect(pm.checkOperation({ operation: "modify", substrate: "web", target: "https://x.com", impact: "modify" }).allowed).toBe(false);
  });

  it("escalates with approvers", () => {
    const pm = new PostureManager();
    const auth = pm.escalate(SecurityPosture.RED_TEAM, { targets: ["https://x.com"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["alice"], ["sig1"], "testing");
    expect(pm.posture).toBe(SecurityPosture.RED_TEAM);
    expect(auth.id).toBeTruthy();
  });

  it("blocks escalation without approvers", () => {
    const pm = new PostureManager();
    expect(() => pm.escalate(SecurityPosture.RED_TEAM, { targets: [], operations: [], maxImpact: "read", maxSubstrates: [] }, [], [], "x")).toThrow(/approver/i);
  });

  it("enforces scope constraints", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.RED_TEAM, { targets: ["https://x.com"], operations: ["read"], maxImpact: "read", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(pm.checkOperation({ operation: "write", substrate: "web", target: "https://x.com", impact: "modify" }).allowed).toBe(false);
    expect(pm.checkOperation({ operation: "read", substrate: "web", target: "https://x.com", impact: "read" }).allowed).toBe(true);
  });

  it("enforces wildcard target scope", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.RED_TEAM, { targets: ["https://*.example.com"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://api.example.com/dash", impact: "modify" }).allowed).toBe(true);
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://evil.com", impact: "modify" }).allowed).toBe(false);
  });

  // ---- R3-hardened target matching ----

  it("denies everything when the scope has no targets (fail closed, not allow-all)", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.RED_TEAM, { targets: [], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://anything.example", impact: "modify" }).allowed).toBe(false);
  });

  it("denies lookalike hosts that merely CONTAIN the authorized host", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["app.example.com"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    // Substring match would have allowed both of these — a scope bypass.
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://app.example.com.evil.io/x", impact: "modify" }).allowed).toBe(false);
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://evil-app.example.com/", impact: "modify" }).allowed).toBe(false);
    // The real host and its subpages stay allowed.
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://app.example.com/", impact: "modify" }).allowed).toBe(true);
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://app.example.com/settings", impact: "modify" }).allowed).toBe(true);
  });

  it("denies lookalike hosts for absolute-URL authorizations too", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["https://app.example.com"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://app.example.com.evil.io/x", impact: "modify" }).allowed).toBe(false);
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://app.example.com/settings", impact: "modify" }).allowed).toBe(true);
  });

  it("keeps path-prefix scoping exact (no /dashboard bypass via /dash)", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["https://x.com/dash"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://x.com/dashboard", impact: "modify" }).allowed).toBe(false);
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://x.com/dash/board", impact: "modify" }).allowed).toBe(true);
  });

  it("keeps glob host matching inside the authorized zone (boundary-anchored)", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["https://*.example.com"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://app.example.com.evil.io/", impact: "modify" }).allowed).toBe(false);
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://api.example.com/dash", impact: "modify" }).allowed).toBe(true);
  });

  it("does not treat regex metacharacters in patterns as regex syntax", () => {
    const pm = new PostureManager();
    // A glob pattern containing "(" used to throw a RegExp SyntaxError at
    // match time; metacharacters must be escaped, and "*" stays a wildcard.
    pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["page/(*)"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(() =>
      pm.checkOperation({ operation: "x", substrate: "web", target: "page/(anything)/detail", impact: "modify" }),
    ).not.toThrow();
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "page/(anything)/detail", impact: "modify" }).allowed).toBe(true);
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "other/detail", impact: "modify" }).allowed).toBe(false);
  });

  it("keeps substring matching for non-network targets (titles, page ids, devices)", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["Chrome"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["desktop"] }, ["a"], ["s"], "t");
    expect(pm.checkOperation({ operation: "x", substrate: "desktop", target: "Chrome - Inbox", impact: "modify" }).allowed).toBe(true);
    expect(pm.checkOperation({ operation: "x", substrate: "desktop", target: "Notepad - notes.txt", impact: "modify" }).allowed).toBe(false);
  });

  it("enforces maxActions limit", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["*"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"], maxActions: 2 }, ["a"], ["s"], "t");
    pm.recordExecution({ operation: "x", substrate: "web", target: "https://x.com", impact: "modify" }, { success: true });
    pm.recordExecution({ operation: "x", substrate: "web", target: "https://x.com", impact: "modify" }, { success: true });
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://x.com", impact: "modify" }).allowed).toBe(false);
  });

  it("deescalate and revoke work", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.RED_TEAM, { targets: ["*"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    pm.deescalate();
    expect(pm.posture).toBe(SecurityPosture.AUDIT);
    pm.escalate(SecurityPosture.RED_TEAM, { targets: ["*"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    pm.revoke();
    expect(pm.checkOperation({ operation: "x", substrate: "web", target: "https://x.com", impact: "modify" }).allowed).toBe(false);
  });

  it("records audit events", () => {
    const pm = new PostureManager();
    pm.escalate(SecurityPosture.COPILOT, { targets: ["*"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    pm.recordExecution({ operation: "x", substrate: "web", target: "https://x.com", impact: "read" }, { success: true });
    pm.deescalate();
    const log = pm.getAuditLog();
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(log[0]?.type).toBe("posture.escalate");
  });
});

describe("helpers", () => {
  it("hashScope deterministic", () => {
    const s = { targets: ["a"], operations: ["b"], maxImpact: "modify" as const, maxSubstrates: ["web" as const] };
    expect(hashScope(s)).toBe(hashScope(s));
  });
  it("generateAuthorizationId hex", () => {
    expect(generateAuthorizationId()).toMatch(/^[0-9a-f]{32}$/);
  });
});