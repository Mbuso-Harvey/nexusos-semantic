/**
 * Web BiDi Substrate Adapter — NexusOS.
 *
 * Implements SubstrateSurface and SubstrateSession over WebDriver BiDi,
 * allowing the state engine and crawlers to treat Web identical to Native Mobile and Desktop.
 */
import type { BiDiSession, Page } from "../bidi-client/index.js";
import type { Source } from "../bidi-client/input.js";
import type { AxTreeNode, WalkResult } from "../extract-structure/structural.js";
import { WALKER_FN } from "../extract-structure/structural.js";
import type {
  SubstrateSurface,
  SubstrateSession,
  SubstrateKind,
  DisplayMetrics,
} from "./types.js";

export class WebBiDiSurface implements SubstrateSurface {
  readonly substrateKind: SubstrateKind = "web-bidi";
  readonly surfaceId: string;

  constructor(private readonly page: Page) {
    this.surfaceId = page.context;
  }

  get underlyingPage(): Page {
    return this.page;
  }

  async getRoute(): Promise<string> {
    return await this.page.url;
  }

  async getTitle(): Promise<string> {
    return (await this.page.title) ?? "";
  }

  async captureScreenshot(): Promise<{ data: Buffer; mimeType: string }> {
    const res = await this.page.bc.captureScreenshot(this.page.context);
    const buf = Buffer.from(res.data, "base64");
    return { data: buf, mimeType: "image/png" };
  }

  async extractAccessibilityTree(): Promise<AxTreeNode[]> {
    const res = await this.page.script.callFunction<WalkResult>(
      this.page.target,
      WALKER_FN,
      [],
    );
    return res?.root ? [res.root] : [];
  }

  async performActions(actions: Source[]): Promise<void> {
    await this.page.input.performActions(this.page.context, actions);
  }

  async getDisplayMetrics(): Promise<DisplayMetrics> {
    const raw = await this.page.script.evaluate<{
      width: number;
      height: number;
      density: number;
    }>(
      this.page.target,
      "({ width: window.innerWidth, height: window.innerHeight, density: window.devicePixelRatio || 1 })",
    );

    const width = raw?.width ?? 1280;
    const height = raw?.height ?? 800;
    const density = raw?.density ?? 1;

    return {
      width,
      height,
      density,
      orientation: width >= height ? "landscape" : "portrait",
      safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    };
  }
}

export class WebBiDiSession implements SubstrateSession {
  readonly substrateKind: SubstrateKind = "web-bidi";
  readonly sessionId: string;

  constructor(private readonly bidiSession: BiDiSession) {
    this.sessionId = bidiSession.sessionId;
  }

  get underlyingSession(): BiDiSession {
    return this.bidiSession;
  }

  async newSurface(): Promise<SubstrateSurface> {
    const page = await this.bidiSession.newPage();
    return new WebBiDiSurface(page);
  }

  async close(): Promise<void> {
    await this.bidiSession.close();
  }
}

