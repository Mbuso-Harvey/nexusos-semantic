import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPair, signAuthorization, verifyAuthorization, isAuthorizationValid } from "../../src/security/authorization.js";
import { AuditStream } from "../../src/security/audit.js";
import { PostureManager, SecurityPosture } from "../../src/security/posture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Authorization cryptography", () => {
  it("generates valid keypair", () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toContain("PUBLIC KEY");
    expect(kp.privateKey).toContain("PRIVATE KEY");
  });

  it("signs and verifies", () => {
    const kp = generateKeyPair();
    const pm = new PostureManager();
    const auth = pm.escalate(SecurityPosture.RED_TEAM, { targets: ["https://x.com"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["alice"], ["placeholder"], "testing");
    const sig = signAuthorization({ id: "alice", publicKey: kp.publicKey, privateKey: kp.privateKey }, auth);
    expect(verifyAuthorization({ id: "alice", publicKey: kp.publicKey }, auth, sig)).toBe(true);
  });

  it("detects tampering", () => {
    const kp = generateKeyPair();
    const pm = new PostureManager();
    const auth = pm.escalate(SecurityPosture.RED_TEAM, { targets: ["https://x.com"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["alice"], ["placeholder"], "testing");
    const sig = signAuthorization({ id: "alice", publicKey: kp.publicKey, privateKey: kp.privateKey }, auth);
    expect(verifyAuthorization({ id: "alice", publicKey: kp.publicKey }, { ...auth, justification: "changed" }, sig)).toBe(false);
  });

  it("validates state", () => {
    const pm = new PostureManager();
    const auth = pm.escalate(SecurityPosture.AUTOPILOT, { targets: ["*"], operations: ["*"], maxImpact: "modify", maxSubstrates: ["web"] }, ["a"], ["s"], "t");
    expect(isAuthorizationValid(auth).valid).toBe(true);
    expect(isAuthorizationValid({ ...auth, revoked: true }).valid).toBe(false);
  });
});

describe("AuditStream", () => {
  let dir: string;
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes hash-chained events to JSONL", async () => {
    dir = await mkdtemp(join(tmpdir(), "nexus-audit-"));
    const stream = new AuditStream({ dir, streamId: "test-stream" });
    await stream.init();
    await stream.record({ type: "posture.escalate", timestamp: Date.now() });
    await stream.record({ type: "operation.execute", operation: "x", substrate: "web", target: "https://x.com", impact: "read", success: true, timestamp: Date.now() });
    await stream.flush();
    await stream.close();
    expect(stream.currentSequence).toBe(2);
    expect(stream.currentHash).not.toBe("GENESIS");
  });
});