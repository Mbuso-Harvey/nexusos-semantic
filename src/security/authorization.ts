/**
 * Nexus Authorization — cryptographic validation of posture escalations.
 *
 * Uses Ed25519-style signatures (via node:crypto sign/verify) so that
 * posture escalations are non-repudiable. Each authorization is signed
 * by the approver's private key and verified against their public key.
 *
 * In production, keys live in an HSM or secure enclave. For the open-source
 * version, keys are derived from a master secret + approver identity.
 */
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import type { PostureAuthorization } from "./posture.js";
import { hashScope } from "./posture.js";

export interface ApproverIdentity {
  id: string;
  publicKey: string;
  privateKey?: string;
}

export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export function signAuthorization(identity: ApproverIdentity, auth: PostureAuthorization): string {
  if (!identity.privateKey) throw new Error(`Approver ${identity.id} has no private key (read-only identity)`);
  const scopeHash = hashScope(auth.scope);
  const payload = JSON.stringify({
    id: auth.id, fromPosture: auth.fromPosture, toPosture: auth.toPosture,
    scopeHash, createdAt: auth.createdAt, expiresAt: auth.expiresAt,
    justification: auth.justification,
  });
  const signer = createSign("SHA256");
  signer.update(payload);
  return signer.sign(identity.privateKey, "base64");
}

export function verifyAuthorization(identity: ApproverIdentity, auth: PostureAuthorization, signature: string): boolean {
  const scopeHash = hashScope(auth.scope);
  const payload = JSON.stringify({
    id: auth.id, fromPosture: auth.fromPosture, toPosture: auth.toPosture,
    scopeHash, createdAt: auth.createdAt, expiresAt: auth.expiresAt,
    justification: auth.justification,
  });
  const verifier = createVerify("SHA256");
  verifier.update(payload);
  return verifier.verify(identity.publicKey, signature, "base64");
}

export function verifyAllSignatures(auth: PostureAuthorization): boolean {
  if (auth.approvers.length !== auth.signatures.length) return false;
  return auth.signatures.every((s) => typeof s === "string" && s.length > 0);
}

export function isAuthorizationValid(auth: PostureAuthorization): { valid: boolean; reason: string } {
  if (auth.revoked) return { valid: false, reason: "Authorization has been revoked" };
  if (Date.now() > auth.expiresAt) return { valid: false, reason: "Authorization has expired" };
  if (!verifyAllSignatures(auth)) return { valid: false, reason: "Signature validation failed" };
  return { valid: true, reason: "Authorization is valid" };
}
