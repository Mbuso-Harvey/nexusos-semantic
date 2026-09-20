/**
 * Authentication barrier detection and Human-in-the-Loop (HITL) handshake.
 *
 * Provides deterministic classification of hardware/biometric security barriers
 * (WebAuthn/FIDO2, SMS/TOTP, Turnstile/CAPTCHA, OAuth) and coordinates pausing
 * state-machine exploration until human intervention or hardware assertion clears.
 */
import { randomUUID } from "node:crypto";
import type { AuthBarrier, AuthBarrierKind, HITLHandshake, ElementStateObservation } from "../graph/types.js";

export interface BarrierEvidence {
  conditionalMarkers?: Record<string, string>;
  elementAria?: Record<string, ElementStateObservation>;
  elementTexts?: string[];
}

/**
 * Classify whether the current page state presents an active authentication barrier.
 */
export function detectAuthBarrier(evidence: BarrierEvidence): AuthBarrier | null {
  const now = new Date().toISOString();

  // 1. Explicit data-marker overrides (e.g. data-auth-barrier="webauthn-hardware")
  if (evidence.conditionalMarkers?.["data-auth-barrier"]) {
    const kind = evidence.conditionalMarkers["data-auth-barrier"] as AuthBarrierKind;
    return {
      kind,
      status: "pending",
      prompt: evidence.conditionalMarkers["data-auth-prompt"] ?? "Hardware authentication challenge active",
      detectedAt: now,
    };
  }

  // 2. Turnstile / CAPTCHA detection
  if (evidence.conditionalMarkers?.["cf-turnstile"] !== undefined ||
      evidence.conditionalMarkers?.["turnstile"] !== undefined ||
      evidence.conditionalMarkers?.["h-captcha"] !== undefined ||
      evidence.conditionalMarkers?.["g-recaptcha"] !== undefined) {
    return {
      kind: "captcha-turnstile",
      status: "pending",
      prompt: "Interactive human verification (Turnstile / CAPTCHA) required",
      detectedAt: now,
    };
  }

  // 3. One-Time Code / TOTP detection from element text or aria
  const texts = evidence.elementTexts ?? [];
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (lower.includes("security key") || lower.includes("insert your usb key") || lower.includes("touch your security key")) {
      return {
        kind: "webauthn-hardware",
        status: "pending",
        prompt: text,
        detectedAt: now,
      };
    }
    if (lower.includes("enter verification code") || lower.includes("two-factor authentication") || lower.includes("authenticator app")) {
      return {
        kind: "sms-totp",
        status: "pending",
        prompt: text,
        detectedAt: now,
      };
    }
  }

  return null;
}

/**
 * Create a Human-in-the-Loop handshake to pause workflow execution pending human/hardware clearance.
 */
export function createHITLHandshake(
  barrier: AuthBarrier,
  stateId: string,
  pageId: string,
  timeoutMs: number = 300_000,
): HITLHandshake {
  return {
    id: `hitl:${randomUUID()}`,
    barrier: { ...barrier },
    stateId,
    pageId,
    timeoutMs,
  };
}

/**
 * Resolve an active HITL handshake once verified, producing causal resumption metadata.
 */
export function resolveHITLHandshake(
  handshake: HITLHandshake,
  resumptionTrigger: string = "hitl:hardware-cleared",
): HITLHandshake {
  return {
    ...handshake,
    barrier: {
      ...handshake.barrier,
      status: "cleared",
      clearedAt: new Date().toISOString(),
    },
    resumptionTrigger,
  };
}
