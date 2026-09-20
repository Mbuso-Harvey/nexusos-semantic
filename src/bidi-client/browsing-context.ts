/**
 * Typed wrapper for the BiDi browsingContext module.
 *
 * Per the env-report: Firefox 154 supports create, navigate, close, getTree,
 * locateNodes, captureScreenshot. activate/getWindows are unverified.
 */
import type { BiDiTransport } from "./transport.js";

export interface BrowsingContextInfo {
  context: string;
  url: string;
  userContext: string;
  parent: string | null;
  children: string[] | null;
}

export interface BoundingBox {
  x: number; y: number; width: number; height: number;
}

export interface ScreenshotResult {
  data: string; // base64-encoded PNG
}

export type Locator =
  | { type: "css"; value: string }
  | { type: "xpath"; value: string }
  | { type: "innerText"; value: string }
  | { type: "accessibility"; role?: string; name?: string };

export interface LocatedNode {
  type: "node";
  sharedId: string;
  value: {
    nodeType: number;
    localName?: string;
    namespaceURI?: string;
    attributes?: Record<string, string>;
    childNodeCount?: number;
    shadowRoot?: string | null;
  };
}

export class BrowsingContextApi {
  constructor(private transport: BiDiTransport) {}

  async create(type: "tab" | "window" = "tab"): Promise<{ context: string }> {
    const r = await this.transport.send<{ context: string }>("browsingContext.create", { type });
    return r;
  }

  /**
   * Navigate the context to a URL.
   * @param wait one of "none" (return immediately on navigation start), "interactive"
   *   (return on DOMContentLoaded), or "complete" (return on load). The "complete"
   *   value is closest to the classic-WebDriver default; callers that want to react
   *   to load events should subscribe via onLoad() instead.
   */
  async navigate(
    context: string,
    url: string,
    wait: "none" | "interactive" | "complete" = "complete",
  ): Promise<{ navigation: string | null; url: string }> {
    const r = await this.transport.send<{ navigation: string | null; url: string }>(
      "browsingContext.navigate",
      { context, url, wait },
    );
    return r;
  }

  async close(context: string): Promise<void> {
    await this.transport.send("browsingContext.close", { context });
  }

  async getTree(root?: string): Promise<{ contexts: BrowsingContextInfo[] }> {
    return await this.transport.send("browsingContext.getTree", root ? { root } : {});
  }

  async locateNodes(context: string, locator: Locator): Promise<{ nodes: LocatedNode[] }> {
    return await this.transport.send("browsingContext.locateNodes", { context, locator });
  }

  async captureScreenshot(context: string): Promise<ScreenshotResult> {
    return await this.transport.send("browsingContext.captureScreenshot", { context });
  }

  /**
   * VI-01: Set viewport dimensions and DPR on the browsing context.
   */
  async setViewport(
    context: string,
    viewport: { width: number; height: number } | null,
    devicePixelRatio?: number | null,
  ): Promise<void> {
    const params: Record<string, any> = { context, viewport };
    if (devicePixelRatio !== undefined && devicePixelRatio !== null) {
      params.devicePixelRatio = devicePixelRatio;
    }
    await this.transport.send("browsingContext.setViewport", params);
  }

  /** Subscribe to browsingContext.load events for a given context. */
  onLoad(handler: (params: { context: string; url: string; navigation: string | null }) => void): () => void {
    return this.transport.events((e) => {
      if (e.method === "browsingContext.load") handler((e as any).params);
    });
  }
}
