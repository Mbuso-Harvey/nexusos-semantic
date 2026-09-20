# Project Constitution — Agent Web Graph

## 1. Project Identity
A persistent, machine-readable representation of a web application's
navigation, semantic structure, visual layout, interaction states, and
executable capabilities, designed so an AI agent queries the graph
instead of clicking pixels. The graph is queried through an
MCP-shaped server whose core is the 5 graph tools (graph.query,
graph.path, graph.tool, graph.act, graph.explain) — extended since
this constitution was written by `graph_invoke` (ED-02 execute path),
`substrate_info` (substrate provenance), and the `visual_*`,
`desktop_*` and `mobile_*` tool groups — and is built by crawling
real apps with WebDriver BiDi against Firefox 154. See ED-08 §3 for
the reconciliation of the tool surface.

**What we are NOT building:** a vision-clicking agent, a DOM scraper,
or a WebMCP-only client. The Agent Web Graph is the missing
*capability-relationship* layer between a11y and execution.

**Target users:** AI agents (and their authors) that need to
understand a web app's structure, capabilities, and state without
round-trips through a browser viewport.

**Architectural pillars (from the brief):**
1. **Navigation Graph** — pages and the edges that connect them.
2. **Semantic Page Structure** — a11y tree as a tree of components.
3. **Visual Layout** — rects, computed styles, and tether relations.
4. **Interaction/State Graph** — states as first-class nodes.
5. **Capabilities/WebMCP** — declared + observed capabilities
   reachable by security tier.

The full brief is in `docs/REQUIREMENTS.md` (added in PR-2) and is
the source of truth.

## 2. Architectural Invariants
1. **Schema is the contract.** All extractors write to the Graph
   defined in `src/graph/`. The contract tests in `test/graph/`
   are the source of truth for what a node is.
2. **Local-first, queryable.** The graph is persisted to disk
   (`graph.json` + `design-tokens.json` + `crawl.cmeta.json`).
   The server is local TCP and/or MCP stdio; no cloud.
3. **WebDriver BiDi is the substrate.** Firefox 154 + geckodriver
   0.36.0. No CDP fallback *for the web substrate* (BiDi has no `cdp`
   module; the `bidi-client` package wraps the BiDi WS protocol).
   **Clarified by ED-08 §4:** Chrome CDP (`src/desktop/chrome-cdp.ts`,
   phase D4) is an *additional desktop* substrate used to drive and
   inspect an already-running Chrome instance and to capture session
   state. It is **not** a fallback for the web BiDi substrate, and the
   web crawl path remains BiDi-only. The two must not be conflated.
4. **No silent substitutions.** Every gap between the brief and
   the code is recorded in `docs/GAP-ANALYSIS.md` with the
   substitution made and the rationale (see ED-05 in
   `docs/EXECUTIVE_DECISIONS.md`).
5. **Pinned runtime.** Node 24, pnpm workspace, TypeScript strict,
   vitest. Python 3.14.6 for any tooling scripts.

## 3. Commit Discipline
- Format: `type(scope): imperative description`
  - types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`
  - scopes: `core`, `crawler`, `extractors`, `server`, `cli`,
    `eval`, `demo`, `docs`
- One logical change per commit.
- Push after every commit. No local pile-up.
- Trailer required:
  `Co-Authored-By: Claude <noreply@anthropic.com>`
- First commit in any new repo follows the methodology rule:
  docs only, no feature code.

## 4. Technology Stack
- **Runtime:** Node 24, Python 3.14.6.
- **Package manager:** pnpm (workspace).
- **Language:** TypeScript (strict mode).
- **Browser substrate:** Firefox 154 + geckodriver 0.36.0.
- **Test runner:** vitest.
- **Server transports:** JSON-RPC 2.0 over local TCP (v1),
  MCP stdio via `@modelcontextprotocol/sdk` (v2, default).
- **Serialization:** JSON for the v1 store on disk
  (`graph.json`, `design-tokens.json`, `crawl.cmeta.json`).
  DTCG format for design tokens.
- **Why these:** the BiDi substrate is real and works; the
  contract is data-only and portable; MCP is the de-facto
  standard for agent ↔ tool.

## 5. Branch Strategy
- `main` is always green. No direct commits to main.
- `feat/PR-{n}-{short-description}` for subatomic PR work.
- `fix/{short-description}` for bug fixes.
- Merge to main after a PR's test gate passes (see §6).
- Branch protection rules (when repo settings allow):
  require PR, require 1 review, require status checks.

## 6. Quality Gates
- `pnpm exec tsc --noEmit` → 0 errors.
- `pnpm test` → 100% of unit + contract tests pass.
- `pnpm run check-env` → exits 0 (BiDi substrate probe).
- `pnpm build` → 0 errors, 0 warnings.
- No hardcoded colors without `var(--token, fallback)`.
- Every UI task in a tracker cites a design source
  (Gemini / ChatGPT / Copilot) per the methodology.
- Every commit message follows the §3 format.
