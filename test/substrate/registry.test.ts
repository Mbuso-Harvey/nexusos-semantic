import { describe, it, expect } from "vitest";
import {
  formatDiscoveryReport,
  type SubstrateProviderStatus,
} from "../../src/substrate/registry.js";

function status(partial: Partial<SubstrateProviderStatus>): SubstrateProviderStatus {
  return {
    kind: "web-bidi",
    family: "web",
    label: "Firefox (WebDriver BiDi)",
    available: true,
    capabilities: ["discover", "inspect"],
    ...partial,
  };
}

describe("formatDiscoveryReport (nexus-substrates/1)", () => {
  it("renders a deterministic, probe-ordered report for all six substrates", () => {
    const substrates: SubstrateProviderStatus[] = [
      status({
        kind: "web-bidi", family: "web",
        label: "Firefox (WebDriver BiDi)",
        detail: "attached session 9c6f",
        targets: [{ id: "ctx-1", label: "Sign up — demo", route: "http://127.0.0.1:7311/" }],
      }),
      status({ kind: "web-cdp", family: "web", label: "Chrome (DevTools Protocol)" }),
      status({
        kind: "desktop-windows", family: "desktop",
        label: "Windows (UI Automation)", available: false,
        reason: "not this platform",
      }),
      status({
        kind: "desktop-macos", family: "desktop",
        label: "macOS (Accessibility API)", available: false,
        reason: "not this platform",
      }),
      status({
        kind: "mobile-android", family: "mobile",
        label: "Android (ADB + UIAutomator2)", available: false,
        reason: "adb not found on PATH",
      }),
      status({
        kind: "mobile-ios", family: "mobile",
        label: "iOS (WebDriverAgent)", available: false,
        reason: "WDA not reachable",
      }),
    ];

    const report = formatDiscoveryReport(substrates);
    // Golden, deterministic output (diff-stable snapshot format).
    expect(report).toBe(
      [
        "nexus-substrates/1",
        "",
        "web-bidi  AVAILABLE  Firefox (WebDriver BiDi)",
        "  attached session 9c6f",
        "  target ctx-1  Sign up — demo  http://127.0.0.1:7311/",
        "  capabilities: discover, inspect",
        "",
        "web-cdp  AVAILABLE  Chrome (DevTools Protocol)",
        "  capabilities: discover, inspect",
        "",
        "desktop-windows  OFF  Windows (UI Automation)",
        "  not this platform",
        "  capabilities: discover, inspect",
        "",
        "desktop-macos  OFF  macOS (Accessibility API)",
        "  not this platform",
        "  capabilities: discover, inspect",
        "",
        "mobile-android  OFF  Android (ADB + UIAutomator2)",
        "  adb not found on PATH",
        "  capabilities: discover, inspect",
        "",
        "mobile-ios  OFF  iOS (WebDriverAgent)",
        "  WDA not reachable",
        "  capabilities: discover, inspect",
      ].join("\n"),
    );
    // pure function: same input → same output (idempotent, snapshot-able)
    expect(formatDiscoveryReport(substrates)).toBe(report);
  });

  it("prefers detail over reason when both are set", () => {
    const report = formatDiscoveryReport([
      status({ detail: "attached tab abc", reason: "unreachable", capabilities: ["discover"] }),
    ]);
    expect(report).toContain("  attached tab abc");
    expect(report).not.toContain("  unreachable");
  });
});
