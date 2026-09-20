import { describe, it, expect } from "vitest";
import {
  detectAuthBarrier,
  createHITLHandshake,
  resolveHITLHandshake,
} from "../../src/extract-state/barrier.js";

describe("Authentication Barrier & HITL Handshake", () => {
  it("detects explicit data-auth-barrier conditional marker", () => {
    const barrier = detectAuthBarrier({
      conditionalMarkers: {
        "data-auth-barrier": "webauthn-hardware",
        "data-auth-prompt": "Insert YubiKey and touch sensor",
      },
    });

    expect(barrier).not.toBeNull();
    expect(barrier?.kind).toBe("webauthn-hardware");
    expect(barrier?.status).toBe("pending");
    expect(barrier?.prompt).toBe("Insert YubiKey and touch sensor");
  });

  it("detects Cloudflare Turnstile / CAPTCHA markers", () => {
    const barrier = detectAuthBarrier({
      conditionalMarkers: { "cf-turnstile": "active" },
    });

    expect(barrier).not.toBeNull();
    expect(barrier?.kind).toBe("captcha-turnstile");
    expect(barrier?.status).toBe("pending");
  });

  it("detects WebAuthn security key prompts from element texts", () => {
    const barrier = detectAuthBarrier({
      elementTexts: ["Sign in with passkey", "Please touch your security key to continue"],
    });

    expect(barrier).not.toBeNull();
    expect(barrier?.kind).toBe("webauthn-hardware");
    expect(barrier?.prompt).toContain("touch your security key");
  });

  it("detects 2FA / TOTP prompts from element texts", () => {
    const barrier = detectAuthBarrier({
      elementTexts: ["Two-factor authentication required. Enter verification code from your authenticator app."],
    });

    expect(barrier).not.toBeNull();
    expect(barrier?.kind).toBe("sms-totp");
  });

  it("creates and resolves a Human-in-the-Loop handshake event", () => {
    const barrier = detectAuthBarrier({
      conditionalMarkers: { "data-auth-barrier": "biometric-passkey" },
    })!;

    const handshake = createHITLHandshake(barrier, "state:abc12345", "page:login", 60000);
    expect(handshake.id).toMatch(/^hitl:/);
    expect(handshake.barrier.status).toBe("pending");
    expect(handshake.stateId).toBe("state:abc12345");
    expect(handshake.pageId).toBe("page:login");

    const resolved = resolveHITLHandshake(handshake, "hitl:biometric-verified");
    expect(resolved.barrier.status).toBe("cleared");
    expect(resolved.barrier.clearedAt).toBeDefined();
    expect(resolved.resumptionTrigger).toBe("hitl:biometric-verified");
  });
});
