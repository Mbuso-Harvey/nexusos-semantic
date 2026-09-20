import { describe, it, expect } from "vitest";
import { WindowsUiaDaemon } from "../../src/desktop/windows/uia-daemon.js";
import { DesktopSubstrateSurface } from "../../src/substrate/desktop-surface.js";

describe("Windows Direct UIA Daemon (Phase D3)", () => {
  const daemon = new WindowsUiaDaemon();

  it("implements DesktopDriverClient interface", () => {
    expect(daemon.platform).toBe("windows");
    expect(typeof daemon.listWindows).toBe("function");
    expect(typeof daemon.getWindowHierarchy).toBe("function");
    expect(typeof daemon.getActiveWindow).toBe("function");
    expect(typeof daemon.dispatchKineticAction).toBe("function");
    expect(typeof daemon.createSurface).toBe("function");
  });

  const isWindows = process.platform === "win32";

  it.runIf(isWindows)("enumerates active desktop windows with valid geometry", async () => {
    const windows = await daemon.listWindows();
    expect(Array.isArray(windows)).toBe(true);
    expect(windows.length).toBeGreaterThan(0);

    const first = windows[0]!;
    expect(first.windowId).toBeDefined();
    expect(typeof first.title).toBe("string");
    expect(first.bounds).toBeDefined();
    expect(typeof first.bounds.width).toBe("number");
    expect(typeof first.bounds.height).toBe("number");
  });

  it.runIf(isWindows)("finds and creates DesktopSubstrateSurface for VS Code or active IDE", async () => {
    const windows = await daemon.listWindows();
    // Find any active code editor or window
    const target = windows.find((w) =>
      w.title.includes("Code") ||
      w.title.includes("Antigravity") ||
      w.title.includes("Visual Studio") ||
      w.processName.toLowerCase().includes("code")
    );

    if (target) {
      const surface = await daemon.createSurface({ windowId: target.windowId });
      expect(surface).toBeInstanceOf(DesktopSubstrateSurface);
      expect(surface.substrateKind).toBe("desktop-windows");

      const route = await surface.getRoute();
      expect(route).toContain("desktop://desktop-windows/");

      const metrics = await surface.getDisplayMetrics();
      expect(metrics.width).toBeGreaterThan(0);
      expect(metrics.height).toBeGreaterThan(0);

      const axTree = await surface.extractAccessibilityTree();
      expect(Array.isArray(axTree)).toBe(true);
      expect(axTree.length).toBeGreaterThan(0);

      const root = axTree[0]!;
      expect(root.role).toBeDefined();
      expect(root.domOrder).toBe(0);
    }
  });
});
