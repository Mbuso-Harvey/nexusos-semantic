import { describe, it, expect, vi } from "vitest";
import {
  MobileSubstrateSurface,
  MobileSubstrateSession,
  type MobileDriverClient,
} from "../../src/substrate/mobile-surface.js";

describe("MobileSubstrateSurface", () => {
  it("wraps Android UIAutomator2 driver client", async () => {
    const mockClient: MobileDriverClient = {
      getPageSource: vi.fn().mockResolvedValue({
        class: "android.widget.FrameLayout",
        resourceId: "android:id/content",
        children: [
          {
            class: "android.widget.Button",
            resourceId: "com.example:id/login_btn",
            text: "Sign In",
            enabled: true,
          },
        ],
      }),
      takeScreenshot: vi.fn().mockResolvedValue(Buffer.from("fake-android-png").toString("base64")),
      performTouchActions: vi.fn().mockResolvedValue(undefined),
      getWindowRect: vi.fn().mockResolvedValue({ width: 1080, height: 2400 }),
      getCurrentActivityOrRoute: vi.fn().mockResolvedValue("com.example.app.LoginActivity"),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const surface = new MobileSubstrateSurface("mobile-android", "login_screen", mockClient);

    expect(surface.substrateKind).toBe("mobile-android");
    expect(surface.surfaceId).toBe("login_screen");

    const route = await surface.getRoute();
    expect(route).toBe("com.example.app.LoginActivity");

    const screenshot = await surface.captureScreenshot();
    expect(screenshot.mimeType).toBe("image/png");
    expect(screenshot.data.toString()).toBe("fake-android-png");

    const tree = await surface.extractAccessibilityTree();
    expect(tree.length).toBe(1);
    expect(tree[0]?.children[0]?.role).toBe("button");
    expect(tree[0]?.children[0]?.name).toBe("Sign In");

    await surface.performActions([]);
    expect(mockClient.performTouchActions).toHaveBeenCalled();

    const metrics = await surface.getDisplayMetrics();
    expect(metrics.width).toBe(1080);
    expect(metrics.height).toBe(2400);
    expect(metrics.orientation).toBe("portrait");
  });

  it("manages session lifecycle with MobileSubstrateSession", async () => {
    const mockClient: MobileDriverClient = {
      getPageSource: vi.fn().mockResolvedValue({}),
      takeScreenshot: vi.fn().mockResolvedValue(""),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };

    const session = new MobileSubstrateSession("mobile-ios", "sess-ios-123", mockClient);
    expect(session.substrateKind).toBe("mobile-ios");
    expect(session.sessionId).toBe("sess-ios-123");

    const surface = await session.newSurface();
    expect(surface.substrateKind).toBe("mobile-ios");

    await session.close();
    expect(mockClient.closeSession).toHaveBeenCalledOnce();
  });
});
