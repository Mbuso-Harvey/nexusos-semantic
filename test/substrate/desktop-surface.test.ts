import { describe, it, expect, vi } from "vitest";
import {
  DesktopSubstrateSurface,
  DesktopSubstrateSession,
  type DesktopDriverClient,
} from "../../src/substrate/desktop-surface.js";

describe("DesktopSubstrateSurface", () => {
  it("wraps Windows UIA driver client", async () => {
    const mockClient: DesktopDriverClient = {
      getAccessibilityTree: vi.fn().mockResolvedValue({
        controlType: "Window",
        name: "Calculator",
        automationId: "CalculatorApp",
        children: [
          {
            controlType: "Button",
            name: "Equals",
            automationId: "equalButton",
            isEnabled: true,
          },
        ],
      }),
      takeScreenshot: vi.fn().mockResolvedValue(Buffer.from("fake-win-png").toString("base64")),
      performInputActions: vi.fn().mockResolvedValue(undefined),
      getActiveWindowBounds: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 800, height: 600 }),
      getActiveWindowTitle: vi.fn().mockResolvedValue("Calculator - Standard"),
      getActiveProcessName: vi.fn().mockResolvedValue("CalculatorApp.exe"),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const surface = new DesktopSubstrateSurface("desktop-windows", "calc_window", mockClient);

    expect(surface.substrateKind).toBe("desktop-windows");
    expect(surface.surfaceId).toBe("calc_window");

    const route = await surface.getRoute();
    expect(route).toBe("desktop://desktop-windows/CalculatorApp.exe/calc_window");

    const title = await surface.getTitle();
    expect(title).toBe("Calculator - Standard");

    const screenshot = await surface.captureScreenshot();
    expect(screenshot.mimeType).toBe("image/png");
    expect(screenshot.data.toString()).toBe("fake-win-png");

    const tree = await surface.extractAccessibilityTree();
    expect(tree.length).toBe(1);
    expect(tree[0]?.role).toBe("dialog");
    expect(tree[0]?.children[0]?.role).toBe("button");
    expect(tree[0]?.children[0]?.name).toBe("Equals");

    await surface.performActions([]);
    expect(mockClient.performInputActions).toHaveBeenCalled();

    const metrics = await surface.getDisplayMetrics();
    expect(metrics.width).toBe(800);
    expect(metrics.height).toBe(600);
    expect(metrics.orientation).toBe("landscape");
  });

  it("manages session lifecycle with DesktopSubstrateSession", async () => {
    const mockClient: DesktopDriverClient = {
      getAccessibilityTree: vi.fn().mockResolvedValue({ role: "AXWindow" }),
      takeScreenshot: vi.fn().mockResolvedValue(""),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const session = new DesktopSubstrateSession("desktop-macos", "sess-mac-456", mockClient);
    expect(session.substrateKind).toBe("desktop-macos");
    expect(session.sessionId).toBe("sess-mac-456");

    const surface = await session.newSurface();
    expect(surface.substrateKind).toBe("desktop-macos");

    await session.close();
    expect(mockClient.closeSession).toHaveBeenCalledOnce();
  });
});
