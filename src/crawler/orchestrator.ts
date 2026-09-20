/**
 * Crawler orchestrator — the BFS loop, URL dedup, budget, and per-page
 * sequence. Plan section 6-7.
 *
 * The orchestrator owns the *crawl*; the extractors own the per-page
 * extraction. The orchestrator's job is to:
 *  1. seed the frontier from a root URL
 *  2. dedup URLs (canonical form) so we never visit the same page twice
 *  3. for each page: open it, run every extractor in order, write nodes/edges
 *     into the shared Graph
 *  4. follow links (BFS) up to the budget (max pages, max time)
 *  5. hand back the populated Graph
 *
 * Extractors are pluggable; the default set wires the six Stages 5-10
 * packages (structure, visual, state-declared, state-observed, behavior,
 * discovery).
 *
 * **PR-8b (items 5, 9).** Before PR-8b, the orchestrator:
 *   - Did not install the network shim (item 5).
 *   - Did not iterate `URL × auth-context` pairs; the same
 *     `AuthContext` was stamped on every State regardless of what
 *     the user configured (item 9).
 *
 * PR-8b adds:
 *   - `CrawlOptions.auths: AuthSpec[]` (default: `[{kind:"anonymous"}]`).
 *   - Per-(URL × auth-context) page navigation with
 *     `applyAuthSpec(page, spec, baseUrl)` before the extractors run.
 *   - Network-shim installation before the observed extractor's run.
 */
import type { Graph } from "../graph/graph.js";
import type { Page } from "../bidi-client/page.js";
import type { PageNode, AuthContext, NetworkContext, ViewportProfile } from "../graph/types.js";
import { BiDiSession } from "../bidi-client/session.js";
import { structuralExtractor } from "../extract-structure/index.js";
import { visualExtractor } from "../extract-visual/index.js";
import { extractStateDeclared, observedExtractor } from "../extract-state/index.js";
import { extractBehavior } from "../extract-behavior/index.js";
import { discoveryExtractor, type DiscoveryRunResult } from "../extract-discovery/index.js";
import { buildNavLinkEdges } from "../extract-discovery/nav-links.js";
import { installNetworkShim, installAndPersistNetworkShim } from "../bidi-client/network.js";
import { parseAuthSpecs, applyAuthSpec, authContextToString, type AuthSpec } from "./auth.js";
import { runCausalAuthFlow } from "../extract-state/state-materialize.js";
import {
  applySessionStorageState,
  loadAuthStateFromFile,
  type SessionStorageState,
} from "./session-auth.js";


/** Convert an `AuthSpec` to the canonical `AuthContext` for stamping
 *  on a `StateNode`. Kept local to the orchestrator so the auth.ts
 *  module stays free of the public `AuthContext` import cycle. */
function authSpecToContext(spec: AuthSpec): AuthContext {
  switch (spec.kind) {
    case "anonymous": return { kind: "anonymous" };
    case "authenticated": return { kind: "authenticated", principal: spec.principal, session: spec.session };
    case "administrator": return { kind: "administrator", principal: spec.principal, session: spec.session };
    case "custom-role": return { kind: "custom-role", role: spec.role, principal: spec.principal, session: spec.session };
  }
}

export interface CrawlBudget {
  maxPages: number;          // hard cap on pages visited
  perPageTimeoutMs: number;  // per-page extraction budget
  totalTimeoutMs: number;    // whole-crawl ceiling
}

export const DEFAULT_BUDGET: CrawlBudget = {
  maxPages: 50,
  perPageTimeoutMs: 15_000,
  totalTimeoutMs: 5 * 60_000,
};

export interface CrawlOptions {
  rootUrl: string;
  budget?: Partial<CrawlBudget>;
  /** Restrict BFS to this origin (default: same origin as root). */
  scope?: "same-origin" | "same-site" | "any";
  /** Optional extractor registry; if omitted, the v1 default set runs. */
  extractors?: Extractor[];
  /** Pre-built BiDiSession; the orchestrator reuses it across pages. */
  session?: BiDiSession;
  /**
   * PR-8 2C: auth context the observed extractor records on every
   * State it materializes. Default: `{ kind: "anonymous" }`. The
   * synthetic demo (T13) drives multiple crawl passes with different
   * auth contexts; the v1 live demo uses the default.
   *
   * **PR-8b (item 9).** `auths` is the new matrix form. When
   * provided, the orchestrator opens one page per (URL × auth
   * context) and unions the results. The legacy `auth` field is
   * still accepted and treated as `auths: [auth]` for backward
   * compat.
   */
  auth?: AuthContext;
  /**
   * PR-8b (item 9): array of auth contexts. The orchestrator runs
   * one crawl pass per spec. Defaults to `[{ kind: "anonymous" }]`.
   */
  auths?: AuthSpec[];
  /**
   * PR-8 2D: network context the observed extractor records on every
   * State. Default: `{ status: "online", evidence: "static" }`. The
   * bidi-client network event subscription would change this to
   * `{ evidence: "bidi:network" }` when wired (T4).
   *
   * **PR-8b (item 5).** The orchestrator installs the fetch/XHR
   * shim before the observed extractor runs and updates the
   * `NetworkContext.evidence` to `"page-instrumented"` when the
   * shim is in place.
   */
  network?: NetworkContext;
  /**
   * PR-8j J6 (test seam): factory for the SEPARATE `BiDiSession`
   * that `runCausalAuthFlow` uses to host its same-page
   * anonymous → applyAuthSpec → reload → new-auth sequence.
   *
   * The auth flow must run on a session that has NOT yet had
   * `applyAuthSpec` called on any of its `Page`s, because BiDi
   * `storage.setCookies` writes to the user-level cookie jar of
   * the WebDriver session — a new `Page` on the same session
   * inherits that jar and would see "State A" as already
   * authenticated, defeating the same-page causal guarantee. A
   * separate `BiDiSession.create()` gives a fresh WebDriver
   * session with an isolated user context (clean cookie jar),
   * so State A is genuinely anonymous.
   *
   * **Why a factory, not a stored field?** The production code
   * path calls this from inside the BFS loop, after the matrix
   * session has been used for `applyAuthSpec`. Tests that
   * supply a `session` mock cannot have the orchestrator call
   * the real `BiDiSession.create()` (the mock would be bypassed
   * and the real call would fail / hit a real geckodriver).
   * Default: `() => BiDiSession.create()`. Tests override with
   * a mock factory returning a pre-built mock session.
   */
  authFlowSessionFactory?: () => Promise<BiDiSession>;
  /**
   * Path to a serialized SessionStorageState file (auth-state.json) to preserve
   * and inject authentication tokens/cookies during the crawl.
   */
  authFile?: string;
  /** Pre-loaded SessionStorageState object. */
  authState?: SessionStorageState;
  /**
   * VI-01: Array of ViewportProfile specifications to crawl/observe.
   * If provided, multi-viewport visual snapshots are captured across
   * each profile without overwriting previous observations.
   */
  viewports?: ViewportProfile[];
}

export interface ExtractorContext {
  graph: Graph;
  page: Page;
  pageNode: PageNode;
  budget: CrawlBudget;
  log: (msg: string) => void;
  /**
   * PR-8 2C: auth context the observed probe loop records on every
   * State it materializes. The orchestrator passes its configured
   * `CrawlOptions.auth` (default: anonymous). Extractors that don't
   * care (e.g. structural) ignore this field.
   */
  auth?: AuthContext;
  /**
   * PR-8 2D: network context the observed probe loop records on every
   * State it materializes. The orchestrator passes its configured
   * `CrawlOptions.network` (default: { evidence: "static" }).
   */
  network?: NetworkContext;
  /**
   * VI-01: Multi-viewport observation profiles configured for this crawl.
   */
  viewports?: ViewportProfile[];
}

export interface ExtractorResult {
  produced: boolean;
  durationMs: number;
  /** Optional: same-origin URLs the orchestrator should enqueue (e.g. discovery). */
  sameOriginUrls?: string[];
  /** Optional: issues or warnings recorded during extraction */
  issues?: Array<{ tag?: string; elementId?: string | null; error: string; [key: string]: any }>;
}

export interface Extractor {
  name: string;
  /** Returns true if the extractor produced new nodes/edges. */
  run(ctx: ExtractorContext): Promise<ExtractorResult>;
}

// ----- v1 default extractors (Stages 5-10 wired in) -----
// Each is the real extractor from the corresponding extract-* package. The
// orchestrator is just the BFS + dedup + budget driver; per-page work
// happens inside these.

export const DEFAULT_EXTRACTORS: Extractor[] = [
  structuralExtractor,
  visualExtractor,
  extractStateDeclared,
  observedExtractor,
  extractBehavior,
  discoveryExtractor,
];

// ----- BFS + dedup -----

interface FrontierEntry {
  url: string;
  canonicalUrl: string;
  discoveredVia: string[];
}
export type { FrontierEntry };

/**
 * True iff `a` is a strict URL-path prefix of `b` (same origin, same
 * query, and `a`'s pathname is a proper ancestor of `b`'s pathname,
 * ending at a `/` boundary). This is the ED-03 rule for parent-page
 * detection: `/settings` is a prefix of `/settings/appearance`, but
 * `/set` is not (no slash boundary), and `/settings` is not a prefix
 * of `/settings` (strict, not reflexive).
 */
function isStrictPrefix(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.origin !== ub.origin) return false;
    if (ua.search !== ub.search) return false;
    const pa = ua.pathname;
    const pb = ub.pathname;
    if (pa === pb) return false;
    if (pa === "/") return pb.length > 1; // root prefix: any non-root path
    if (!pb.startsWith(pa)) return false;
    // Must end at a slash boundary so /set doesn't prefix /settings.
    return pa.endsWith("/") || pb[pa.length] === "/";
  } catch {
    return false;
  }
}

interface ResolvedOptions {
  rootUrl: string;
  budget: CrawlBudget;
  scope: "same-origin" | "same-site" | "any";
  extractors: Extractor[];
  /** PR-8b (item 9): the canonical list of auth contexts to crawl under. */
  auths: AuthSpec[];
  /** Legacy `auth` field, kept for backward compat with old callers. */
  auth: AuthContext;
  network: NetworkContext;
  /** PR-8b (item 5): whether to install the network shim before the
   *  observed extractor runs. Default: true. */
  installNetworkShim: boolean;
  /** PR-8j J6 (test seam): factory for the separate BiDi session
   *  used by `runCausalAuthFlow`. See `CrawlOptions.authFlowSessionFactory`. */
  authFlowSessionFactory: () => Promise<BiDiSession>;
  authFile?: string;
  authState?: SessionStorageState;
  /** VI-01: multi-viewport profile configurations */
  viewports?: ViewportProfile[];
}

export class Crawler {
  private graph: Graph;
  private opts: ResolvedOptions;
  private frontier: FrontierEntry[] = [];
  private visited = new Set<string>();
  private session: BiDiSession | null;
  private ownsSession: boolean;
  private startTime = 0;
  private loadedAuthState: SessionStorageState | null = null;

  constructor(graph: Graph, opts: CrawlOptions) {

    this.graph = graph;
    // PR-8b (item 9): resolve `auths` first; fall back to `auth`;
    // fall back to anonymous.
    const auths: AuthSpec[] = opts.auths
      ?? (opts.auth ? [opts.auth as AuthSpec] : [{ kind: "anonymous" }]);
    this.opts = {
      rootUrl: opts.rootUrl,
      budget: { ...DEFAULT_BUDGET, ...(opts.budget ?? {}) },
      scope: opts.scope ?? "same-origin",
      extractors: opts.extractors ?? DEFAULT_EXTRACTORS,
      auths,
      auth: opts.auth ?? auths[0] as AuthContext ?? { kind: "anonymous" },
      network: opts.network ?? { status: "online", evidence: "static" },
      installNetworkShim: true,
      // PR-8j J6 (test seam): default to the real
      // `BiDiSession.create()`; tests inject a mock factory so
      // the auth flow runs against the same mock session the
      // rest of the crawl uses, instead of trying to call
      // out to a real geckodriver.
      authFlowSessionFactory: opts.authFlowSessionFactory ?? (() => BiDiSession.create()),
      authFile: opts.authFile,
      authState: opts.authState,
      viewports: opts.viewports,
    };
    this.session = opts.session ?? null;
    this.ownsSession = opts.session == null;
  }

  static canonicalize(url: string): string {
    try {
      const u = new URL(url);
      u.hash = "";
      // Drop trailing slash on paths that are not "/" themselves.
      if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.replace(/\/+$/, "");
      }
      // Sort query params for stable dedup.
      const params = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
      u.search = "";
      for (const [k, v] of params) u.searchParams.append(k, v);
      return u.href;
    } catch {
      return url;
    }
  }

  inScope(root: string, candidate: string): boolean {
    if (this.opts.scope === "any") return true;
    try {
      const r = new URL(root);
      const c = new URL(candidate);
      if (this.opts.scope === "same-origin") return r.origin === c.origin;
      if (this.opts.scope === "same-site") {
        const rHost = r.hostname.split(".").slice(-2).join(".");
        const cHost = c.hostname.split(".").slice(-2).join(".");
        return rHost === cHost;
      }
    } catch { return false; }
    return false;
  }

  /**
   * Build a Map<pageId, PageNode> view of the graph's pages. Used by the
   * ED-03 parent-detection helper, which needs O(1) lookup of all
   * already-crawled pages. We exclude the page we just upserted (which
   * is also the page we're picking a parent for) by filtering on id.
   */
  private graphPagesForHierarchy(): Map<string, PageNode> {
    const m = new Map<string, PageNode>();
    for (const p of this.graph.pages()) m.set(p.id, p);
    return m;
  }

  /**
   * ED-08 §8 (audit finding F7): does this page have *any* AxNode?
   *
   * Used to distinguish "the structural walker legitimately returned an
   * empty tree" from "the structural walker failed to produce a tree at
   * all". The caller pairs this with the extractor's own `produced`
   * flag; a `produced: false` with zero AxNodes is a hard extraction
   * failure and is recorded as an extractor diagnostic so that
   * `awg inspect --fail-on-diagnostics` fails loudly rather than
   * reporting a healthy, silently-empty graph.
   */
  private pageHasAxNodes(pageId: string): boolean {
    return this.graph.axByPage(pageId).length > 0;
  }

  /**
   * Pure helper exposed for unit tests. Picks the parent page id for a
   * newly-crawled page using the ED-03 rules:
   *   1. URL-prefix rule (primary): the longest already-crawled
   *      `canonicalUrl` that is a strict prefix of the new page's
   *      `canonicalUrl`. Tie-break: insertion order (Map preserves
   *      insertion order in JS, so the first hit wins on equal length).
   *   2. Referrer fallback: the first entry in `discoveredVia` (the URL
   *      the page was reached through), if and only if that page is in
   *      the graph and is *not* a strict prefix candidate of its own.
   *   3. No parent (`null`) otherwise (e.g. the entry/root page).
   *
   * @param newPageCanonicalUrl  canonical form of the new page's URL
   * @param referrerUrl          the URL that linked to this page, or null
   * @param existingPages        map of pageId -> PageNode for crawled pages
   */
  static findParentPageId(
    newPageCanonicalUrl: string,
    referrerUrl: string | null,
    existingPages: ReadonlyMap<string, PageNode>,
  ): string | null {
    // Pass 1: longest strict URL-prefix match.
    let bestId: string | null = null;
    let bestLen = -1;
    for (const [id, p] of existingPages) {
      if (p.canonicalUrl === newPageCanonicalUrl) continue; // not a strict prefix
      if (isStrictPrefix(p.canonicalUrl, newPageCanonicalUrl)) {
        if (p.canonicalUrl.length > bestLen) {
          bestId = id;
          bestLen = p.canonicalUrl.length;
        }
      }
    }
    if (bestId !== null) return bestId;

    // Pass 2: referrer fallback. The referrer is the URL we followed to
    // discover this page; if it's been crawled, use that as the parent.
    // The brief mentions referrer-based hierarchies and ED-03 rejects
    // "build only from referrer" but accepts it as a fallback.
    if (referrerUrl) {
      const referrerCanon = Crawler.canonicalize(referrerUrl);
      for (const [id, p] of existingPages) {
        if (p.canonicalUrl === referrerCanon) return id;
      }
    }

    return null;
  }

  async crawl(): Promise<{ graph: Graph; pages: number; budget: CrawlBudget; browserVersion: string | null }> {
    this.startTime = Date.now();
    const canonicalRoot = Crawler.canonicalize(this.opts.rootUrl);
    this.frontier.push({ url: this.opts.rootUrl, canonicalUrl: canonicalRoot, discoveredVia: ["seed"] });
    this.visited.add(canonicalRoot);

    if (!this.session) {
      this.session = await BiDiSession.create();
    }
    const session = this.session;

    let pagesCrawled = 0;
    if (this.opts.authState) {
      this.loadedAuthState = this.opts.authState;
    } else if (this.opts.authFile) {
      try {
        this.loadedAuthState = await loadAuthStateFromFile(this.opts.authFile);
      } catch (e) {
        console.warn(`[crawl] failed to load authFile "${this.opts.authFile}": ${(e as Error).message}`);
      }
    }


    while (this.frontier.length > 0) {
      if (pagesCrawled >= this.opts.budget.maxPages) break;
      if (Date.now() - this.startTime > this.opts.budget.totalTimeoutMs) break;

      const entry = this.frontier.shift()!;
      const log = (msg: string) => console.log(`[crawl] ${msg}`);
      log(`visit (${pagesCrawled + 1}/${this.opts.budget.maxPages}) ${entry.url}`);

      // PR-8b (item 9): iterate `URL × auth-context` pairs. Each
      // auth context opens its own BiDi `Page` and runs the full
      // extractor pipeline. The legacy `this.opts.auth` was a single
      // value stamped on every State regardless of context — that
      // was the item 9 overclaim. PR-8b actually configures the
      // session per auth context. The `discoveryResultsAcrossAuths`
      // accumulator captures the discovery extractor's output from
      // the *last* successful auth context's run; the BFS enqueue
      // uses that for the per-URL link set.
      let discoveryResultsAcrossAuths: DiscoveryRunResult | null = null;
      for (const authSpec of this.opts.auths) {
        let page: Page | null = null;
        // PR-8c (item 4): the shim handle is per-(page, auth-context)
        // because the shim is per-document. Declared here so the
        // `finally` block can dispose it before the page closes.
        let networkShimHandle: { dispose: () => void; reinstall: () => Promise<unknown>; initialInstall: Promise<unknown> } | null = null;
        try {
          page = await session.newPage();
          // Apply the auth spec to the real page (sets cookies /
          // localStorage / request headers via BiDi). This is the
          // real-session configuration; the auth context is no
          // longer a "stamped but unbacked" annotation.
          await applyAuthSpec(page, authSpec, this.opts.rootUrl);
          if (this.loadedAuthState) {
            await applySessionStorageState(page, this.loadedAuthState, this.opts.rootUrl);
          }

          // PR-8b (item 5): install the network shim so the
          // observed probe loop's `network-wait` probe has a real
          // mechanism to drain in-flight requests. The shim's
          // existence flips `NetworkContext.evidence` from
          // `"static"` to `"page-instrumented"`.
          let networkContext: NetworkContext = this.opts.network;
          // PR-8c (item 4): the shim must survive navigations, since
          // a new document wipes `window.__awgNetworkShim`. The
          // persisting variant exposes a `reinstall()` method the
          // orchestrator invokes after every navigate(). Dispose is
          // wired in the auth-context teardown.
          if (this.opts.installNetworkShim) {
            try {
              networkShimHandle = installAndPersistNetworkShim(page);
              networkContext = {
                status: this.opts.network?.status ?? "online",
                evidence: "page-instrumented",
              };
            } catch (e) {
              log(`  [network-shim] install FAILED: ${(e as Error).message}; falling back to static`);
            }
          }
          const authContext: AuthContext = authSpecToContext(authSpec);
          log(`  [auth] ${authContextToString(authContext)}`);

          await page.navigate(entry.url);
          // PR-8c (item 4): the shim is per-document. A navigation
          // creates a new document and wipes the global, so we
          // re-install after every navigate(). The shim body is
          // idempotent, so this is cheap.
          if (networkShimHandle) await networkShimHandle.reinstall().catch(() => undefined);
          // PR-8f: read the real browser viewport (innerWidth /
          // innerHeight / devicePixelRatio) so the PageNode carries
          // the actual viewport, not a 1280x800x1 placeholder. The
          // declared materializer uses the PageNode viewport as a
          // fallback; the live `window.innerWidth` keeps both paths
          // converging.
          let actualViewport: { w: number; h: number; dpr: number } = { w: 1280, h: 800, dpr: 1 };
          try {
            const v = await page.script.evaluate<{ w: number; h: number; dpr: number } | null>(
              page.target,
              "(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }))()",
            );
            if (v && typeof v.w === "number" && typeof v.h === "number" && typeof v.dpr === "number") {
              actualViewport = v;
            }
          } catch (e) {
            log(`  [viewport-read-failed] ${(e as Error).message}; using default 1280x800x1`);
          }
          const url = await page.url;
          const title = await page.title;
          const canonical = Crawler.canonicalize(url);
          // ED-03: determine parent *after* the page is in the graph so the
          // helper can scan existingPages. We use a placeholder id before the
          // URL is known, then re-upsert with the real id and parent set.
          const pageNode: PageNode = {
            id: `page:${canonical}`,
            type: "page",
            url,
            title,
            discoveredVia: entry.discoveredVia,
            loadStatus: "complete",
            axTreeRef: { rootAxId: "ax:root", provenance: "bidi:script.evaluate" },
            viewport: actualViewport,
            tokensOverride: null,
            screenshotRef: null,
            canonicalUrl: canonical,
            crawledAt: new Date().toISOString(),
            parentPageId: null,
          };
          this.graph.upsertPage(pageNode);
          // ED-03: pick the parent and emit the nav:child-of edge. We use
          // the first element of discoveredVia (the referrer URL) for the
          // fallback rule; the seed root has discoveredVia = ["seed"] which
          // is not a real referrer, so the helper's referrer branch won't
          // match (no crawled page has canonicalUrl === "seed").
          const referrer = entry.discoveredVia.length > 0 && entry.discoveredVia[0] !== "seed"
            ? (entry.discoveredVia[0] as string)
            : null;
          const parentId = Crawler.findParentPageId(canonical, referrer, this.graphPagesForHierarchy());
          if (parentId !== null) {
            this.graph.upsertPage({ ...pageNode, parentPageId: parentId });
            this.graph.upsertEdge({
              id: `edge:${parentId}->${pageNode.id}:nav:child-of`,
              type: "edge",
              from: parentId,
              to: pageNode.id,
              kind: "nav:child-of",
              provenance: "html:hierarchy",
            });
          }

          // ED-08 §8 (audit finding F7): track what the structural walker
          // actually claimed. `null` means "structure was not in the
          // extractor list" (custom extractor sets), which is not a
          // failure — only an explicit `produced: false` is.
          let structuralProduced: boolean | null = null;
          for (const ex of this.opts.extractors) {
            try {
              const r = await ex.run({
                graph: this.graph, page, pageNode, budget: this.opts.budget, log,
                auth: authContext, network: networkContext, viewports: this.opts.viewports,
              });
              if (ex.name === "structure") {
                structuralProduced = Boolean((r as ExtractorResult | undefined)?.produced);
              }
              if (ex.name === "discovery" && r && (r as DiscoveryRunResult).sameOriginUrls) {
                discoveryResultsAcrossAuths = r as DiscoveryRunResult;
              }
            } catch (e) {
              const errMsg = (e as Error).message;
              log(`  [${ex.name}] FAILED: ${errMsg}`);
              this.graph.recordExtractorFailure(pageNode.id, ex.name, errMsg);
              if (ex.name === "structure") {
                pageNode.loadStatus = "spa-error";
                this.graph.upsertPage(pageNode);
              }
            }
          }

          // ED-08 §8 (audit finding F7): an empty graph must be *visible*.
          // Previously a structural walker that returned `produced: false`
          // (e.g. `script.callFunction` returned a shape without `.root`)
          // only wrote a log line; the orchestrator then continued and
          // persisted a PageNode with zero AxNodes. A broken extraction was
          // therefore indistinguishable from a genuinely empty page, and
          // the crawl reported success. Record it as a first-class
          // diagnostic so `awg inspect --fail-on-diagnostics` can fail
          // loudly. This deliberately does NOT set `loadStatus` — the page
          // did load; it is the *extraction* that produced nothing.
          if (structuralProduced === false && !this.pageHasAxNodes(pageNode.id)) {
            const msg = "structural walker produced no accessibility tree (page has 0 AxNodes)";
            log(`  [structure] EMPTY GRAPH: ${msg}`);
            this.graph.recordExtractorFailure(pageNode.id, "structure", msg);
          }

          // PR-8j T1 (causal auth): the `auth` transition is wired
          // ONLY by the same-page causal flow in
          // `runCausalAuthFlow`. The matrix crawl above still
          // iterates per-(URL × auth-context) for the discovery +
          // observed probes (each auth context may produce
          // different observable states), but it does NOT
          // manufacture the auth transition. The previous
          // `findAuthTwin`-style lookup at this site was the
          // matrix-twin defect the user audit identified: it
          // paired State A and State B across DIFFERENT `Page`
          // objects in DIFFERENT BiDi sessions. The fix is to
          // delegate the entire auth transition to
          // `runCausalAuthFlow`, which takes a SINGLE `Page`
          // and runs the full anonymous → applyAuthSpec →
          // reload → new-auth sequence on it.
          //
          // **PR-8j J6 (codex review fix).** The auth flow
          // runs on a SEPARATE BiDi session, not on a new
          // `Page` of the matrix session. The matrix session
          // is the one that just had `applyAuthSpec` run on it
          // (line 364), so its cookie jar already contains
          // the auth cookies; a new `Page` in the same
          // session inherits that jar and would see
          // "State A" as already authenticated — defeating
          // the same-page causal guarantee. A separate
          // `BiDiSession.create()` (via the
          // `authFlowSessionFactory` seam) gives a fresh
          // WebDriver session with an isolated user context
          // (clean cookie jar), so State A is genuinely
          // anonymous. The factory seam exists so tests
          // that supply a mock `session` do not have the
          // orchestrator call the real `BiDiSession.create()`
          // behind their back.
          if (authContext.kind !== "anonymous") {
            let authFlowSession: BiDiSession | null = null;
            let authFlowPage: Page | null = null;
            try {
              // PR-8j J6 (test seam): use the injected
              // factory (default: `BiDiSession.create()`).
              // The factory exists so tests that supply a
              // mock `session` do not have the orchestrator
              // call out to a real geckodriver behind their
              // back. The mock factory returns a pre-built
              // mock session that exposes the same surface
              // (`newPage`, `close`) the production code
              // uses.
              authFlowSession = await this.opts.authFlowSessionFactory();
              authFlowPage = await authFlowSession.newPage();
              const authFlow = await runCausalAuthFlow({
                graph: this.graph,
                page: authFlowPage,
                pageId: pageNode.id,
                route: entry.url,
                spec: authSpec,
                baseUrl: this.opts.rootUrl,
                log: (msg) => log(`  [runCausalAuthFlow] ${msg}`),
                network: networkContext,
              });
              if (authFlow.edgeEmitted > 0) {
                log(`  [auth-transition-causal] emitted ${authFlow.edgeEmitted} state:successor edge trigger=auth from=${authFlow.fromStateId} to=${authFlow.toStateId}`);
              } else {
                log(`  [auth-transition-causal] no edge emitted (fromStateId='${authFlow.fromStateId}' toStateId='${authFlow.toStateId}')`);
              }
            } catch (e) {
              log(`  [auth-transition-causal] FAILED: ${(e as Error).message}`);
            } finally {
              if (authFlowPage) {
                try { await authFlowPage.close(); } catch { /* swallow */ }
              }
              if (authFlowSession) {
                try { await authFlowSession.close(); } catch { /* swallow */ }
              }
            }
          }

          // PR-8a: post-discovery pass — resolve the page-to-page nav-link
          // edges. The discovery extractor wrote per-link axId-level
          // "link" edges; the Layer 1 navigation graph also wants the
          // resolved page-to-page relationship. We walk the graph's
          // existing "link" edges from this page, and for every
          // same-origin, non-anchor target whose canonical URL is now
          // a known page, emit one "nav-link" edge from this page to
          // that page. Idempotent: nav-link edge id is deterministic.
          const navLinkEdges = buildNavLinkEdges(this.graph, pageNode.id);
          for (const e of navLinkEdges) this.graph.upsertEdge(e);
          if (navLinkEdges.length > 0) {
            log(`  [nav-links] emitted ${navLinkEdges.length} page-to-page edges`);
          }

          pagesCrawled++;
        } catch (e) {
          const errMsg = (e as Error).message;
          const isTimeout = /timeout|timed out/i.test(errMsg);
          const status = isTimeout ? "timeout" : "spa-error";
          log(`FAILED ${entry.url}: ${errMsg}`);
          this.graph.recordPageError(entry.url, errMsg, status);
          const canonical = Crawler.canonicalize(entry.url);
          const failedPageId = `page:${canonical}`;
          if (!this.graph.getPage(failedPageId)) {
            this.graph.upsertPage({
              id: failedPageId,
              type: "page",
              url: entry.url,
              title: "Load Failed",
              discoveredVia: entry.discoveredVia,
              loadStatus: status,
              axTreeRef: { rootAxId: `ax:${failedPageId}:failed`, provenance: "bidi:script.evaluate" },
              viewport: { w: 1280, h: 800, dpr: 1 },
              tokensOverride: null,
              screenshotRef: null,
              canonicalUrl: canonical,
              crawledAt: new Date().toISOString(),
              parentPageId: null,
            });
          }
        } finally {
          if (networkShimHandle) networkShimHandle.dispose();
          if (page) await page.close().catch(() => undefined);
        }
      }

      // BFS: collect outbound links from the discovery extractor's
      // accumulated result (one set of links per URL, regardless of
      // how many auth contexts were configured). The discovery
      // extractor returns the page's same-origin `<a href>` URLs.
      const linksToEnqueue: string[] = discoveryResultsAcrossAuths?.sameOriginUrls ?? [];
      for (const link of linksToEnqueue) {
        if (!this.inScope(this.opts.rootUrl, link)) continue;
        const canon = Crawler.canonicalize(link);
        if (this.visited.has(canon)) continue;
        this.visited.add(canon);
        this.frontier.push({ url: link, canonicalUrl: canon, discoveredVia: [entry.url] });
      }
    }

    if (this.ownsSession && this.session) {
      await this.session.close();
    }

    // PR-8a: final pass — re-resolve nav-link edges for every page.
    // The per-page post-discovery emission only sees the graph state
    // at the moment the page was crawled, so back-edges (root → child
    // when child is crawled last) need a second sweep after the BFS
    // completes. Idempotent: the deterministic edge id makes this
    // a no-op for already-emitted edges.
    let finalNavLinkCount = 0;
    for (const p of this.graph.pages()) {
      const more = buildNavLinkEdges(this.graph, p.id);
      for (const e of more) this.graph.upsertEdge(e);
      finalNavLinkCount += more.length;
    }
    if (finalNavLinkCount > 0) {
      console.log(`[crawl] [nav-links] final-pass edges=${finalNavLinkCount}`);
    }

    return { graph: this.graph, pages: pagesCrawled, budget: this.opts.budget, browserVersion: session.browserVersion ?? null };
  }
}
