/**
 * Desktop Automation Substrate Exports — NexusOS.
 */
import type { DesktopDriverClient } from "../substrate/desktop-surface.js";
import { WindowsUiaDaemon } from "./windows/uia-daemon.js";
import { MacOSAxDaemon } from "./macos/ax-daemon.js";

export * from "./windows/uia-daemon.js";
export * from "./macos/ax-daemon.js";
export * from "./chrome-cdp.js";
export * from "./session-capture.js";

/**
 * Thrown when the host operating system has no native desktop automation
 * driver.
 *
 * **Audit finding F4:** the previous implementation silently fell back to
 * `WindowsUiaDaemon` on Linux, which then failed deep inside the PowerShell
 * UIA bridge with a confusing "script not found" style error. Failing loudly
 * at construction time tells the caller the truth: Linux desktop automation
 * is not implemented.
 */
export class UnsupportedPlatformError extends Error {
  constructor(public readonly platform: string) {
    super(
      `No native desktop automation driver for platform "${platform}". ` +
      `NexusOS Semantic supports Windows (UI Automation) and macOS (AX API). ` +
      `Linux desktop automation is not implemented — use the Web substrate instead.`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * Returns the native desktop automation daemon appropriate for the current host OS.
 *
 * @throws {UnsupportedPlatformError} on any platform other than `win32` / `darwin`.
 */
export function createDesktopDaemon(): DesktopDriverClient {
  if (process.platform === "win32") {
    return new WindowsUiaDaemon();
  }
  if (process.platform === "darwin") {
    return new MacOSAxDaemon();
  }
  throw new UnsupportedPlatformError(process.platform);
}

