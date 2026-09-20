# Nexus Capability Audit & Substrate Reach Matrix

> **Purpose.** Enumerate every tool Nexus needs to observe and operate on any web,
> desktop, or mobile surface, with explicit fallback layers. The goal is a
> **no-lazy-gap** stance: for every surface, there is a primary path and at least
> one alternative. Nothing is "impossible" — it is either built, partially built,
> or planned, and this document records which.
>
> **Directive from principal (2026-09):** *"I don't want to hear impossible...
> think of every possibility that could stop us from reaching any place on the
> web, desktop, and build those tools, we install them... build multiple layers
> and fallbacks."*

---

## 1. The Reach Problem, Precisely

The earlier failure mode: an agent claimed "Nexus can't read authenticated page
content" because the **Windows UIA bridge** (the only attached desktop tool at
that time) cannot see inside a Chromium tab's DOM. That statement was *true for
that one tool* but wrong as a claim about the system — because **Chrome exposes
its page DOM through the Chrome DevTools Protocol (CDP)**, which we now attach to.

The audit below enumerates the complete toolset across every substrate so no
single missing tool can ever again be reported as a system limitation.

---

## 2. Web Substrate — Reach Matrix

| Surface | Primary Tool | Fallback 1 | Fallback 2 | Status |
|---|---|---|---|---|
| Browser tabs & targets | `chrome_targets` (CDP `/json/list`) | `desktop_list_windows` (UIA tab titles) | — | **BUILT (D4)** |
| Page DOM / text | `chrome_read_tab` (CDP `Runtime.evaluate` → `innerText`) | `bidi` crawl (Firefox WebDriver BiDi) | UIA screen-reader text providers (best-effort) | **BUILT (D4)** |
| Page HTML / structure | `CdpSession.getPageHtml` / `DOM.getDocument` | BiDi extractors (`extract-structure`, `extract-visual`) | — | **BUILT** |
| Cookies (incl. httpOnly) | `chrome_get_cookies` (CDP `Network.getAllCookies`) | BiDi `network` storage export | `document.cookie` via evaluate | **BUILT (D4)** |
| localStorage / sessionStorage | `chrome_snapshot_tab` (CDP evaluate) | `session-auth.ts` state apply/export | — | **BUILT (D4)** |
| Screenshots | `CdpSession.screenshot` (`Page.captureScreenshot`) | `desktop` UIA window capture | BiDi `browsingContext.captureScreenshot` | **BUILT** |
| Navigate a live tab | `chrome_navigate` (CDP `Page.navigate`) | BiDi `browsingContext.navigate` | `desktop_kinetic_action` (type URL + Enter) | **BUILT (D4)** |
| Launch browser with debug port | `chrome_launch` (`launchChromeWithDebug`) | manual `--remote-debugging-port` | — | **BUILT (D4)** |
| Firefox automation | BiDi session (geckodriver `127.0.0.1:4444`) | — | — | **BUILT** (geckodriver installed v0.36.0) |

## 3. Desktop Substrate — Reach Matrix

| Surface | Primary Tool | Fallback | Status |
|---|---|---|---|
| Window enumeration | `desktop_list_windows` (UIA / AX) | — | **BUILT (D3)** |
| Accessibility tree of a window | `desktop_scrape_window` (UIA PowerShell bridge / AX daemon) | — | **BUILT (D3)** |
| Kinetic input (click/type/hotkey) | `desktop_kinetic_action` (native OS dispatch) | BiDi kinetic events (web only) | **BUILT (D3)** |
| Browser page DOM (Windows) | **CDP (D4)** | UIA text providers (limited) | **BUILT (D4)** — closes the UIA gap |
| Filesystem / workspace | `src/substrate/workspace-surface.ts` | `process-surface.ts` | **BUILT** |
| Terminal / processes | `src/substrate/process-surface.ts`, `terminal-surface.ts` | — | **BUILT** |

## 4. Mobile Substrate — Reach Matrix

| Surface | Primary Tool | Fallback | Status |
|---|---|---|---|
| Device enumeration | `mobile_list_devices` (ADB) | — | **BUILT (M3)** |
| Screen accessibility tree | `mobile_scrape_device` (UIAutomator2 / WDA) | — | **BUILT (M3)** |
| Kinetic touch | `mobile` action dispatch | — | **BUILT (M3)** |
| iOS | WDA client (`wda-client.ts`) | — | **BUILT** |
## 5. The Multi-Layer Fallback Doctrine

For **any** requested read, the system tries layers in order until one succeeds:

1. **Structured protocol** (CDP / BiDi / UIAutomator / WDA) — fastest, richest.
2. **OS accessibility** (UIA / AX) — for native desktop without a protocol.
3. **Kinetic + screenshot + OCR** — for surfaces with no programmatic access at all.
4. **User-assisted** — the operator pastes a value into a `.env`; Nexus verifies read-only.

**Owner-authorized only.** Every path reads the current user's own machine,
sessions, and accounts. No exfiltration, no persistence of secrets to disk, no
cross-account reach.

---

## 6. What Was Just Delivered (Phase D4)

- **`src/desktop/chrome-cdp.ts`** (rewritten clean, 528 lines, `tsc` clean):
  - `CdpSession` — WS request/response correlation, `send`, `evaluate`,
    `getPageHtml/Text/Cookies`, `getLocalStorage/SessionStorage`, `getTitle/Url`,
    `snapshot()`, `getDocument`, `querySelector`, `getAllCookies`,
    `getCookiesForUrls`, `screenshot`, `activate`, `navigate`.
  - `ChromeCdpClient` — target discovery (`/json/list`, `/json/version`),
    `listPages`, `isReachable`, `withSession`, `attachSession`.
  - `launchChromeWithDebug` + `findChromeExecutable` — spawn Chrome with
    `--remote-debugging-port`, wait for the endpoint.
  - One-shots: `isChromeCdpReachable`, `readTabByUrl`, `snapshotTabByUrl`,
    `extractChromeCookies`.
- **Six new MCP tools** in `src/server/mcp-server.ts` behind `opts.chrome`:
  `chrome_targets`, `chrome_read_tab`, `chrome_snapshot_tab`,
  `chrome_get_cookies`, `chrome_navigate`, `chrome_launch`.
- **Hermetic tests** `test/desktop/chrome-cdp.test.ts` (7) + CDP tool
  registration tests in `test/desktop/mcp-desktop-tools.test.ts` (3) — all pass
  without a live browser.
- Exported from `src/desktop/index.ts`.

## 7. Honest Residual Limits (Not "Impossible" — Structured)

| Limit | Why | Workaround |
|---|---|---|
| A secret value never rendered to the page (server-side only) | Not in DOM/storage/cookies | Operator supplies it; Nexus never fabricates |
| Secret hidden behind a masked input / "reveal" click | Not exposed by default | CDP `evaluate` can click reveal then read the value (owner-authorized) |
| Hardware-bound / TOTP secrets | Deliberately not exfiltratable | Manual entry, verify read-only |
| Chrome not launched with debug port | No endpoint to attach to | `chrome_launch` (built) or relaunch with `--remote-debugging-port` |
| Renderer-only memory (WASM) | Not reachable via evaluate | OCR layer (planned) |

## 8. Planned Fallback Layers (Roadmap)

- **OCR / screenshot-text layer** for surfaces with zero programmatic DOM access.
- **CDP flatten + full-HTML structured ingestion** into the existing graph extractors
  so authenticated pages can be *crawled* (not just read).
- **`nexus chrome` CLI subcommand** mirroring the six MCP tools for scripting.
