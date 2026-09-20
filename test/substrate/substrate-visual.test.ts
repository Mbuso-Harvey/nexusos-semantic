import { describe, it, expect, vi } from "vitest";
import { DesktopSubstrateSurface, type DesktopDriverClient } from "../../src/substrate/desktop-surface.js";
import { MobileSubstrateSurface, type MobileDriverClient } from "../../src/substrate/mobile-surface.js";

describe("Substrate Visual Parity (VI-05)", () => {
  describe("DesktopSubstrateSurface.extractVisualNodes", () => {
    it("converts Windows UIA tree into VisualNode hierarchy with visual patterns", async () => {
      const mockClient: DesktopDriverClient = {
        getAccessibilityTree: vi.fn().mockResolvedValue({
          controlType: "Window",
          automationId: "win_root",
          boundingRectangle: { x: 0, y: 0, width: 1920, height: 1080 },
          children: [
            {
              controlType: "Button",
              automationId: "btn_save",
              boundingRectangle: { x: 1800, y: 1000, width: 56, height: 56 }, // FAB candidate
            },
          ],
        }),
        takeScreenshot: vi.fn().mockResolvedValue(""),
        closeSession: vi.fn().mockResolvedValue(undefined),
      };

      const surface = new DesktopSubstrateSurface("desktop-windows", "surface-1", mockClient);
      const visNodes = await surface.extractVisualNodes("page:desktop");

      expect(visNodes).toHaveLength(2);
      expect(visNodes[0]!.axId).toBe("ax:win_root");
      expect(visNodes[0]!.isVisualContainer).toBe(true);
      expect(visNodes[0]!.provenance).toBe("desktop:windows-uia");

      const btnNode = visNodes[1]!;
      expect(btnNode.axId).toBe("ax:btn_save");
      expect(btnNode.rect).toEqual({ x: 1800, y: 1000, w: 56, h: 56 });
      expect(btnNode.primaryPattern).toBe("fab");
    });
  });

  describe("MobileSubstrateSurface.extractVisualNodes", () => {
    it("converts Android node bounds into VisualNode hierarchy with visual patterns", async () => {
      const mockClient: MobileDriverClient = {
        getPageSource: vi.fn().mockResolvedValue({
          className: "android.widget.FrameLayout",
          resourceId: "layout_root",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          children: [
            {
              className: "android.widget.ImageButton",
              resourceId: "fab_add",
              bounds: { left: 950, top: 2200, right: 1050, bottom: 2300 }, // 100x100 bottom-right
            },
          ],
        }),
        takeScreenshot: vi.fn().mockResolvedValue(""),
        getWindowRect: vi.fn().mockResolvedValue({ width: 1080, height: 2400 }),
        closeSession: vi.fn().mockResolvedValue(undefined),
      };

      const surface = new MobileSubstrateSurface("mobile-android", "surface-mobile", mockClient);
      const visNodes = await surface.extractVisualNodes("page:mobile");

      expect(visNodes).toHaveLength(2);
      expect(visNodes[0]!.axId).toBe("ax:layout_root");
      expect(visNodes[0]!.isVisualContainer).toBe(true);
      expect(visNodes[0]!.provenance).toBe("mobile:android-uia2");

      const fabNode = visNodes[1]!;
      expect(fabNode.axId).toBe("ax:fab_add");
      expect(fabNode.rect).toEqual({ x: 950, y: 2200, w: 100, h: 100 });
      expect(fabNode.primaryPattern).toBe("fab");
    });
  });
});
