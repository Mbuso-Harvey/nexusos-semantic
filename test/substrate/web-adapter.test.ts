import { describe, it, expect, vi } from "vitest";
import { WebBiDiSurface, WebBiDiSession } from "../../src/substrate/web-adapter.js";
import type { Page, BiDiSession } from "../../src/bidi-client/index.js";

describe("WebBiDiSubstrateAdapter", () => {
  describe("WebBiDiSurface", () => {
    it("wraps Page and implements SubstrateSurface interface", async () => {
      const mockPage = {
        context: "ctx-1234",
        url: Promise.resolve("https://example.com/dashboard"),
        title: Promise.resolve("Dashboard - Example"),
        target: { context: "ctx-1234" },
        bc: {
          captureScreenshot: vi.fn().mockResolvedValue({ data: Buffer.from("fake-png-bytes").toString("base64") }),
        },
        input: {
          performActions: vi.fn().mockResolvedValue(undefined),
        },
        script: {
          callFunction: vi.fn().mockResolvedValue({
            root: {
              domOrder: 0,
              tag: "body",
              elementId: null,
              role: "document",
              name: "",
              nameSource: "content",
              states: {} as any,
              properties: {} as any,
              apgPattern: null,
              focusable: false,
              visibility: "visible",
              children: [],
            },
            count: 1,
          }),
          evaluate: vi.fn().mockResolvedValue({ width: 1920, height: 1080, density: 2 }),
        },
      } as unknown as Page;

      const surface = new WebBiDiSurface(mockPage);

      expect(surface.substrateKind).toBe("web-bidi");
      expect(surface.surfaceId).toBe("ctx-1234");
      expect(surface.underlyingPage).toBe(mockPage);

      const route = await surface.getRoute();
      expect(route).toBe("https://example.com/dashboard");

      const title = await surface.getTitle();
      expect(title).toBe("Dashboard - Example");

      const screenshot = await surface.captureScreenshot();
      expect(screenshot.mimeType).toBe("image/png");
      expect(screenshot.data.toString()).toBe("fake-png-bytes");

      const tree = await surface.extractAccessibilityTree();
      expect(tree.length).toBe(1);
      expect(tree[0]?.role).toBe("document");

      await surface.performActions([]);
      expect(mockPage.input.performActions).toHaveBeenCalledWith("ctx-1234", []);

      const metrics = await surface.getDisplayMetrics();
      expect(metrics.width).toBe(1920);
      expect(metrics.height).toBe(1080);
      expect(metrics.density).toBe(2);
      expect(metrics.orientation).toBe("landscape");
      expect(metrics.safeAreaInsets).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    });

    it("correctly computes portrait orientation when height > width", async () => {
      const mockPage = {
        context: "ctx-portrait",
        target: { context: "ctx-portrait" },
        script: {
          evaluate: vi.fn().mockResolvedValue({ width: 390, height: 844, density: 3 }),
        },
      } as unknown as Page;

      const surface = new WebBiDiSurface(mockPage);
      const metrics = await surface.getDisplayMetrics();
      expect(metrics.width).toBe(390);
      expect(metrics.height).toBe(844);
      expect(metrics.orientation).toBe("portrait");
    });
  });

  describe("WebBiDiSession", () => {
    it("wraps BiDiSession and manages surface lifecycles", async () => {
      const mockPage = { context: "ctx-page-1" } as unknown as Page;
      const mockSession = {
        sessionId: "sess-abc",
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as BiDiSession;

      const substrateSession = new WebBiDiSession(mockSession);

      expect(substrateSession.substrateKind).toBe("web-bidi");
      expect(substrateSession.sessionId).toBe("sess-abc");
      expect(substrateSession.underlyingSession).toBe(mockSession);

      const surface = await substrateSession.newSurface();
      expect(surface.substrateKind).toBe("web-bidi");
      expect(surface.surfaceId).toBe("ctx-page-1");
      expect(mockSession.newPage).toHaveBeenCalledOnce();

      await substrateSession.close();
      expect(mockSession.close).toHaveBeenCalledOnce();
    });
  });
});

