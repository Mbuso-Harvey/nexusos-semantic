/**
 * PR-8 2D: network/async-driven state capture.
 *
 * The WebDriver BiDi `network.enable` command is not yet supported in
 * Firefox 154 (per PR-7's env report). The fallback is to inject a
 * fetch + XHR shim into the page that records in-flight requests, so
 * the observed probe loop can wait for them to settle before taking
 * the after-snapshot.
 *
 * **PR-8b (item 5).** Before PR-8b, `buildNetworkShim()` was
 * defined but never installed by the orchestrator. The shim's
 * existence was effectively dead code. PR-8b adds a public
 * `install()` function that wraps the shim source in a callable and
 * exposes it on `window.__awg_flushRequests()` so the observed
 * probe loop's `network-wait` probe can drain in-flight requests
 * before taking the after-snapshot.
 *
 * **PR-8c (item 4).** The shim is a single window-scoped
 * install, and a navigation creates a new document (wiping the
 * global). PR-8c adds `installAndPersistNetworkShim(page)` that
 * subscribes to `browsingContext.load` and re-installs the shim
 * after every load.
 */
import type { Page } from "./page.js";

export interface NetworkShim {
  /** The JS source to install on the page (via callFunction or evaluate). */
  source: string;
  /** The NetworkContext.evidence value the substrate records when the shim is installed. */
  evidence: "page-instrumented";
}

/** Build the network shim source.
 *
 *  IMPORTANT: the body MUST be a BiDi function expression (an
 *  arrow or function expression), NOT an immediately-invoked
 *  expression. The WebDriver BiDi `script.callFunction` takes a
 *  `functionDeclaration` parameter, which is parsed as a
 *  function expression; trailing `()` to invoke the function
 *  produces a SyntaxError at the BiDi parser layer. Side effects
 *  are realized by the function body itself, and the install
 *  command passes `awaitPromise: false` so the synchronous
 *  `'installed'` return is observable. */
export function buildNetworkShim(): NetworkShim {
  const source = `() => {
    if (window.__awgNetworkShim) return 'already-installed';
    const inflight = new Set();
    const requests = [];
    const origFetch = window.fetch && window.fetch.bind(window);
    if (origFetch) {
      window.fetch = function(...args) {
        const id = Math.random().toString(36).slice(2);
        const startedAt = Date.now();
        inflight.add(id);
        requests.push({ id, kind: 'fetch', url: String(args[0]), startedAt });
        return origFetch(...args).then((r) => {
          inflight.delete(id);
          const finishedAt = Date.now();
          const last = requests[requests.length - 1];
          if (last && last.id === id) { last.status = r.status; last.finishedAt = finishedAt; }
          return r;
        }, (err) => {
          inflight.delete(id);
          const finishedAt = Date.now();
          const last = requests[requests.length - 1];
          if (last && last.id === id) { last.error = String(err); last.finishedAt = finishedAt; }
          throw err;
        });
      };
    }
    const OrigXHR = window.XMLHttpRequest;
    function WrappedXHR() {
      const xhr = new OrigXHR();
      const id = Math.random().toString(36).slice(2);
      const startedAt = Date.now();
      let rec = { id, kind: 'xhr', startedAt };
      const origOpen = xhr.open;
      xhr.open = function(...a) {
        rec.url = String(a[1]);
        inflight.add(id);
        requests.push(rec);
        return origOpen.apply(xhr, a);
      };
      xhr.addEventListener('loadend', () => {
        inflight.delete(id);
        rec.status = xhr.status;
        rec.finishedAt = Date.now();
      });
      return xhr;
    }
    WrappedXHR.prototype = OrigXHR.prototype;
    WrappedXHR.UNSENT = 0; WrappedXHR.OPENED = 1; WrappedXHR.HEADERS_RECEIVED = 2; WrappedXHR.LOADING = 3; WrappedXHR.DONE = 4;
    window.XMLHttpRequest = WrappedXHR;
    window.__awgNetworkShim = {
      inFlightCount: () => inflight.size,
      inFlightIds: () => Array.from(inflight),
      requests: () => requests.slice(),
    };
    // PR-8b (item 5): the network-wait probe drains the queue and
    // resolves when the in-flight count is zero. The probe loop
    // installs this hook via install() and then calls
    // window.__awg_flushRequests() to wait for any in-flight
    // requests triggered by the previous probe to settle before
    // taking the after-snapshot.
    window.__awg_flushRequests = (timeoutMs) => {
      const deadline = Date.now() + (timeoutMs || 2000);
      return new Promise((resolve) => {
        const tick = () => {
          if (inflight.size === 0) return resolve({ drained: true, count: 0 });
          if (Date.now() > deadline) return resolve({ drained: false, count: inflight.size });
          setTimeout(tick, 30);
        };
        tick();
      });
    };
    return 'installed';
  }`;
  return { source, evidence: "page-instrumented" };
}

/**
 * PR-8b (item 5): install the network shim into a page. Returns
 * the shim descriptor so the caller can update
 * `NetworkContext.evidence` to `"page-instrumented"`.
 *
 * Idempotent: if `window.__awgNetworkShim` is already present, the
 * shim's body returns `"already-installed"` and the function
 * returns the same descriptor without re-installing.
 *
 * Note: this variant does NOT survive navigation. Use
 * `installAndPersistNetworkShim` if the crawl navigates the
 * page after install.
 */
export async function installNetworkShim(page: Page): Promise<NetworkShim> {
  const shim = buildNetworkShim();
  await page.script.callFunction(page.target, shim.source, []);
  return shim;
}

/**
 * Handle returned by {@link installAndPersistNetworkShim}.
 *
 * PR-8c (item 4): the substrate's WebDriver BiDi transport in
 * Firefox 154 does NOT stream `browsingContext.load` events on
 * the WebSocket (per PR-7's env report; the `browsingContext.subscribe`
 * command is unverified). We therefore cannot subscribe to load
 * events and rely on them firing.
 *
 * Instead, the caller drives the persistence model: after every
 * `page.navigate()` the caller invokes `handle.reinstall()` to
 * re-install the shim (which is idempotent and cheap — its body
 * short-circuits if the global is already present, or installs
 * it if not). The orchestrator wires `reinstall()` into its
 * crawl loop right after each navigation.
 *
 * The handle exposes:
 *   - `shim`: the NetworkShim descriptor (for the
 *     NetworkContext.evidence bookkeeping).
 *   - `initialInstall`: a promise resolving on the first install
 *     (callers can await to confirm the shim is present before
 *     the first probe runs).
 *   - `reinstall()`: re-runs the shim install on the page. Safe
 *     to call any number of times; returns the install promise.
 *   - `dispose()`: no-op (kept for API symmetry).
 */
export interface NetworkShimHandle {
  shim: NetworkShim;
  initialInstall: Promise<unknown>;
  reinstall: () => Promise<unknown>;
  dispose: () => void;
}

/**
 * PR-8c (item 4): install the network shim and expose a
 * `reinstall()` method that callers (typically the orchestrator)
 * invoke after every navigation. The shim's body is idempotent
 * so re-installs are cheap.
 */
export function installAndPersistNetworkShim(page: Page): NetworkShimHandle {
  const shim = buildNetworkShim();
  const install = () => page.script.callFunction(page.target, shim.source, []);
  const initialInstall = install();
  return {
    shim: { source: shim.source, evidence: "page-instrumented" },
    initialInstall,
    reinstall: install,
    dispose: () => {
      // No subscription to dispose; the orchestrator tears down
      // by closing the page, which invalidates the underlying
      // context and all of its handlers.
    },
  };
}
