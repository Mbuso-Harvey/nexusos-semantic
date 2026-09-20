/**
 * Mobile Automation Substrate Exports — NexusOS.
 */
import { AndroidClient } from "./android/uia2-client.js";
import { WdaClient } from "./ios/wda-client.js";
import { MobileSubstrateSurface, MobileSubstrateSession } from "../substrate/mobile-surface.js";

export * from "./android/uia2-client.js";
export * from "./ios/wda-client.js";

/**
 * Creates an Android Substrate surface using the given device ID (or first available ADB device).
 */
export async function createAndroidSurface(deviceId?: string): Promise<MobileSubstrateSurface> {
  const client = new AndroidClient({ deviceId });
  if (!deviceId) {
    const devices = await client.listDevices();
    const firstDevice = devices[0];
    if (firstDevice) {
      client.setDevice(firstDevice.id);
    }
  }
  return new MobileSubstrateSurface("mobile-android", deviceId ?? "default-android", client);
}

/**
 * Creates an iOS Substrate surface connecting to WebDriverAgent.
 */
export function createIOSSurface(opts?: { host?: string; port?: number; sessionId?: string }): MobileSubstrateSurface {
  const client = new WdaClient(opts);
  return new MobileSubstrateSurface("mobile-ios", opts?.sessionId ?? "default-ios", client);
}
