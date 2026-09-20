/**
 * High-level Page object — bundles browsingContext + script + input + storage
 * around a single BiDi context. This is the primary surface for the extractors.
 */
import type { BiDiSession } from "./session.js";
import { BrowsingContextApi, type ScreenshotResult, type Locator, type LocatedNode } from "./browsing-context.js";
import { ScriptApi, type ScriptTarget } from "./script.js";
import { InputApi } from "./input.js";
import { StorageApi } from "./storage.js";

export interface PageScreenshot {
  /** base64-encoded PNG from the BiDi WS path */
  bidi: ScreenshotResult;
  /** base64-encoded PNG from the classic HTTP path (used as the visual anchor) */
  classic: string;
}

export class Page {
  readonly context: string;
  readonly bc: BrowsingContextApi;
  readonly script: ScriptApi;
  readonly input: InputApi;
  readonly storage: StorageApi;
  private loadResolvers: Array<(url: string) => void> = [];

  constructor(
    private session: BiDiSession,
    context: string,
  ) {
    this.context = context;
    this.bc = new BrowsingContextApi(session.transport);
    this.script = new ScriptApi(session.transport);
    this.input = new InputApi(session.transport);
    this.storage = new StorageApi(session.transport);
    this.bc.onLoad((p) => {
      if (p.context === context) {
        for (const r of this.loadResolvers) r(p.url);
        this.loadResolvers = [];
      }
    });
  }

  get url(): Promise<string> {
    return this.script.evaluate<string>({ context: this.context }, "location.href");
  }

  get title(): Promise<string> {
    return this.script.evaluate<string>({ context: this.context }, "document.title");
  }

  get target(): ScriptTarget {
    return { context: this.context };
  }

  async navigate(url: string): Promise<void> {
    // Firefox 154 BiDi: wait: "complete" blocks the BiDi response until load fires.
    // We don't get a separate browsingContext.load event to subscribe to (the
    // browsingContext.subscribe command is not implemented). So this call's return
    // *is* the load signal.
    await this.bc.navigate(this.context, url, "complete");
  }

  /**
   * Reload the current page by re-navigating to its current URL.
   * Firefox 154 BiDi does not implement `browsingContext.reload`, so
   * reload is implemented as a re-navigate. The page-side script
   * reads `location.href` and we issue a `navigate()` with the same
   * URL and `wait: "complete"` so the call returns on the post-reload
   * `load` event. Returns the URL the reload re-navigated to.
   *
   * **PR-8i T1.** Used by `runCausalAuthFlow` to make the page's
   * JavaScript pick up the cookies that `applyAuthSpec` set via
   * real BiDi `storage.setCookies` (PR-8d showed cookies are
   * written to the BiDi cookie jar; the page reads them on the
   * next navigation).
   */
  async reload(): Promise<string> {
    const current = await this.url;
    await this.bc.navigate(this.context, current, "complete");
    return current;
  }

  /**
   * VI-01: Set viewport dimensions and DPR on this page context.
   */
  async setViewport(profile: { w: number; h: number; dpr?: number } | { width: number; height: number; devicePixelRatio?: number }): Promise<void> {
    const width = "w" in profile ? profile.w : profile.width;
    const height = "h" in profile ? profile.h : profile.height;
    const dpr = "dpr" in profile ? profile.dpr : (profile as any).devicePixelRatio;
    await this.bc.setViewport(this.context, { width, height }, dpr);
  }

  /**
   * Wait for the next browsingContext.load event (or timeout).
   *
   * NOTE: Firefox 154 BiDi does not implement `browsingContext.subscribe` and
   * does not stream load events on the WS. This helper is a no-op-timeout in
   * practice against Firefox 154; it exists for forward-compat with future
   * BiDi implementations (Chrome 153+). Use `navigate()` which already blocks
   * until load via the `wait: "complete"` parameter.
   */
  waitForLoad(timeoutMs: number = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.loadResolvers = this.loadResolvers.filter((r) => r !== resolver);
        reject(new Error(`waitForLoad timeout after ${timeoutMs}ms (Firefox 154 BiDi does not stream load events; use navigate() instead)`));
      }, timeoutMs);
      const resolver = (url: string) => { clearTimeout(t); resolve(url); };
      this.loadResolvers.push(resolver);
    });
  }

  /** Locate elements by CSS / XPath / text. Returns sharedIds usable as element handles. */
  async locate(locator: Locator): Promise<LocatedNode[]> {
    const r = await this.bc.locateNodes(this.context, locator);
    return r.nodes;
  }

  /** Take screenshots via both BiDi and classic HTTP, returning both base64 PNGs. */
  async screenshot(): Promise<PageScreenshot> {
    const [bidi, classic] = await Promise.all([
      this.bc.captureScreenshot(this.context),
      this.classicScreenshot(),
    ]);
    return { bidi, classic: classic.value };
  }

  /** Classic WebDriver HTTP screenshot — preferred for the visual anchor
   *  because it returns a full-page shot without the BiDi viewport quirk. */
  private async classicScreenshot(): Promise<{ value: string }> {
    const r = await fetch(`${this.session.webDriverBase}/session/${this.session.sessionId}/screenshot`);
    if (!r.ok) throw new Error(`classic screenshot failed: ${r.status}`);
    return await r.json() as { value: string };
  }

  async close(): Promise<void> {
    await this.bc.close(this.context);
  }
}
