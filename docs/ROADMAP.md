# Roadmap

## Phase 1 — Repo baseline (Sessions 1-2)
- **PR-1 (P0):** constitution + 5 mandatory docs + repo skeleton.
  *Session 1.*
- **PR-2 (P1):** brief as canonical requirement.
  *Session 2.*

## Phase 2 — Source + methodology + audit (Sessions 3-7)
- **PR-3 (P2):** import 21 stages of source tree.
  *Sessions 3-5 (large import).*
- **PR-4 (P3):** working methodology in docs/methodology/.
  *Session 6.*
- **PR-5 (P4):** 5-layer gap analysis.
  *Session 7.*

## Phase 3 — Gap closure (Sessions 8-12)
One PR per ED, in order, planned one at a time:
- **PR-6 (P5):** ED-04 — A11y tree is a tree.
  *Session 8.*
- **PR-7 (P6):** ED-03 — Pages carry parent/child edges.
  *Session 9.*
- **PR-8 (P7):** ED-01 — Interaction states are first-class
  graph nodes. *Session 10.*
- **PR-9 (P8):** ED-02 — Capabilities are executable.
  *Session 11.*
- **PR-10 (P9):** ED-05 — ratification pass; GAP-ANALYSIS.md
  is the single source of truth for the brief ↔ code delta.
  *Session 12.*

## Visual Intelligence Extensions (VI Track)
- **VI-01: Multi-Viewport Visual Snapshot Capture & queryViewportDiff** (DONE)
  - Multi-profile visual snapshots across viewports (desktop, tablet, mobile).
  - Per-viewport observations dictionary `viewportObservations` on VisualNode.
  - Geometric and style diffing via `graph.queryViewportDiff(axId, fromViewport, toViewport)`.
  - JSON-RPC / MCP tools `query_viewport_diff` and viewport predicates in `graph_query`.
- **VI-02: Layout Box Model Evidence, Visual Containers, and Stacking Contexts** (DONE)
  - Box model geometry: content, padding, border, margin boxes and edge measurements.
  - Stacking context and paint order indices calculation.
  - Scroll clipping metrics and overflow containment.
  - Post-transform client render bounds computation.
  - Visual container classifier ("hero" | "grid" | "flex" | "card" | "section" | "scroll" | "container" | "wrapper").
  - Synthetic AxNode generation for non-semantic visual containers.
  - Query predicates (`isVisualContainer`, `containerType`, `isScrollContainer`, etc.) and SQLite indexing.
- **VI-03: Occlusion Detection, Visual Clipping Trees, and Spatial Proximity Edges** (DONE)
  - True visible area computation under viewport and ancestor clipping boundaries (`computeAncestorClipping`).
  - Paint-order occlusion calculation via 2D boolean rect subtraction (`computeNodeOcclusion`, `computePageOcclusion`).
  - Spatial proximity relationships (`visual:above`, `visual:below`, `visual:left-of`, `visual:right-of`, `visual:nested-in`).
  - Graph traversal (`graph.spatialNeighbors`, `graph.occludedNodes`) and query predicates (`isOccluded`, `minVisibleRatio`, `maxVisibleRatio`, `isOffscreen`).
  - SQLite store v2 indexing and JSON-RPC / MCP server exposure (`get_spatial_neighbors`, `get_occluded_nodes`).
- **VI-04: Semantic Visual Labeling, High-Level Patterns, and Responsive Layout Breakpoint Diffing** (DONE)
  - Semantic visual pattern classification: Floating Action Buttons (`fab`), Modal Backdrops (`modal-backdrop`), Dialog Overlays (`dialog-overlay`), Sticky Headers (`sticky-header`), Sticky Footers (`sticky-footer`), Dismiss Buttons (`dismiss-button`), Form Groups (`form-group`), and Toast Notifications (`toast-notification`).
  - Cross-view responsive layout mutation classification (`reflow`, `hide`, `show`, `reorder`, `reposition`, `unchanged`) with severity rating.
  - Page-level responsive layout mutation analysis via `graph.queryPageLayoutMutations(pageId, fromVp, toVp)`.
  - Pattern traversal `graph.visualPatterns(pageId, pattern, minConfidence)` and query predicates (`where.visualPattern`, `where.hasPattern`, `where.isFab`, `where.isModalBackdrop`, `where.isStickyHeader`, `where.isStickyFooter`, `where.isDismissButton`, `where.isFormGroup`).
  - MCP tools (`get_visual_patterns`, `query_page_layout_mutations`, `get_visual_containers`, `get_spatial_neighbors`, `get_occluded_nodes`) & JSON-RPC TCP wire methods.
  - SQLite store v2 indexing (`primary_pattern` column and index).
- **VI-05: Visual Regression Diffing & DTCG Design Token Binding** (DONE)
  - Visual regression diffing engine (`diffVisualNodes`, `diffPageVisualRegression`, `graph.diffVisualRegression`) computing layout shifts, dimension changes, style drift, token detachment, occlusion changes, and semantic pattern degradation.
  - Core Web Vitals layout shift metric normalization (`layoutShiftScore`, `cumulativeLayoutShift`).
  - Multi-type design token binding with confidence scoring (`bindTokensToNode`) and token drift linting (`detectTokenDrifts`).
  - Standard W3C DTCG Token Bundle export (`exportDtcgBundle`, `graph.exportDtcgTokens`).
  - Cross-substrate visual parity on `DesktopSubstrateSurface` and `MobileSubstrateSurface` (`extractVisualNodes`).
  - Graph query predicates (`where.hasTokenBinding`, `where.tokenPath`, `where.hasTokenDrift`, `where.driftSeverity`).
  - MCP tools (`query_visual_regression`, `lint_design_tokens`, `export_dtcg_tokens`) & JSON-RPC TCP wire methods.
  - End-to-end CLI access via `awg diff <baseline> <candidate> [--page] [--json]` and `awg tokens [--export-dtcg <file>] [--lint] [--graph] [--page] [--json]`.
  - SQLite store v2 indexes token bindings and drift presence (`has_tokens`, `has_drifts` columns + indices) for fast filtering on large crawls.

## VI-06 extension candidates (not started)
Potential next milestones on the VI track, proposed for planning:
- **Temporal baselines** — persist per-crawl visual regression baselines in SQLite so `awg diff` can diff against a named historical baseline without keeping two graph dirs on disk.
- **Pixel-level screenshot diffing** — complement box-model regression diffing with rasterized screenshot comparison for sub-pixel rendering defects.
- **CI gate mode** — `awg diff --fail-on critical|high` exit-code semantics so visual regressions can gate merge pipelines.
- **Multi-theme token export** — light/dark theme DTCG bundle export with cross-theme token drift linting.

## Performance Optimization Track (NEXUS-PERF)

System-wide investigation of Nexus end-to-end performance across every substrate.
Goal: make Nexus more accurate, more efficient, and faster — simultaneously where
possible, with accuracy as a hard floor. Evidence-driven: profile first, then
optimize the 20% of behavior causing 80% of the cost.

- **NEXUS-PERF-01: Performance Cost Map (Phase 1)** (DONE)
  - Architecture-derived baseline of the crawler critical path
    (`docs/nexus-perf-cost-map.md`).
  - Execution graph, per-stage cost inventory, I×F×O ranking matrix, headline
    metrics, and Step-0 measurement plan.
  - **Substrate resolved (2026-09-13):** geckodriver v0.36.0 installed at
    `C:/Users/Harvey/AppData/Local/Temp/geckodriver.exe`, Firefox present at
    `C:/Program Files/Mozilla Firefox/firefox.exe`, `pnpm run check-env` passes
    (matches `docs/PR-8h-check-env.txt`). Reproducible via
    `node scripts/install-geckodriver.mjs`.

- **NEXUS-PERF-02: Live Measurement & Instrumentation** (READY — substrate unblocked)
  - Start `demo/saas` server, run one fresh crawl and one eval trace, instrument
    the crawl loop with per-stage timing
    (`ExtractorResult.durationMs` already exists — aggregate + add session/nav
    timing).
  - Replace [NEEDS MEASURE] values in the headline metrics table with real data.
  - Calibrate the I×F×O scores against measured latency.


- **NEXUS-PERF-01: Performance Cost Map (Phase 1)** (IN PROGRESS)
  - Architecture-derived baseline of the crawler critical path
    (`docs/nexus-perf-cost-map.md`).
  - Execution graph, per-stage cost inventory, I×F×O ranking matrix, headline
    metrics, and Step-0 measurement plan.
  - **Blocker:** `geckodriver` not on PATH — live measurement deferred until the
    browser substrate is stood up.

- **NEXUS-PERF-02: Live Measurement & Instrumentation** (BLOCKED on substrate)
  - Stand up geckodriver + `demo/saas` server, run one fresh crawl and one eval
    trace, instrument the crawl loop with per-stage timing
    (`ExtractorResult.durationMs` already exists — aggregate + add session/nav
    timing).
  - Replace [NEEDS MEASURE] values in the headline metrics table with real data.
  - Calibrate the I×F×O scores against measured latency.

- **NEXUS-PERF-03: Top-2 High-Leverage Interventions** (PLANNED)
  - **Sequential extractor dispatch** — fan out the 5 read-only extractors
    (structure, visual, declared, behavior, discovery) concurrently; run
    `observed` (the only write-side-effect extractor) last. Code-certain finding,
    needs live measurement to quantify gain.
  - **Observed probe fixed-wait reduction** — replace the fixed 300ms
    `POST_ACTION_SETTLE_MS` with event-driven completion (transition fired /
    network idle / rAF quiescence).量化 the latency savings vs. any reliability
    regression before adopting.

- **NEXUS-PERF-04: Substrate Discovery, Pre-Mapping & Caching** (PLANNED)
  - Investigate targeted shallow mapping, predictive pre-mapping, parallel
    discovery, persistent substrate maps, delta mapping, context minimization,
    and model routing — per the investigation spec. Each hypothesis must be
    benchmarked: expected gain vs. measured gain vs. token/compute impact vs.
    accuracy impact.




## Out-of-band (completed)
- `awg-viewer` trace viewer (`awg view` / zero-CDN single-file visualization). (DONE)
- Real GitHub crawl + fixture population for the eval harness (`buildGitHubGraph`, `github-populated-tasks.json`). (DONE)
- OPFS / SQLite store v2 (`SqliteGraphStore` with native `node:sqlite` high-performance indexing). (DONE)
- Authenticated sessions (`SessionStorageState`, cookie/storage state export & import, `--auth-file`). (DONE)
- Standalone SEA binary executable verification (`pnpm build:sea` -> `dist/bin/nexus.exe`). (DONE)

