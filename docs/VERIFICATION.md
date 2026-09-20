# Verification Report

> **GENERATED FILE — DO NOT EDIT BY HAND.**
>
> Produced by `scripts/emit-verification.mjs` from `test-results.junit.xml`.
> Regenerate with `pnpm test && node scripts/emit-verification.mjs`.
>
> This file exists because hand-written test tallies drifted across
> `UNIVERSAL_LAUNCH.md`, `AUDIT-PR-13.md`, `CAPABILITY_AUDIT.md` and
> `PR-8d-audit.md` (audit finding F2). Cite this file, never a number
> copied into prose.

> **This file is deterministic by design:** no timestamps, no
> durations, suites sorted by name. The CI drift gate
> (`node scripts/emit-verification.mjs --check`) regenerates it on
> every run and fails the build when the committed copy is stale or
> hand-edited.

- **Source artifact:** `test-results.junit.xml`
- **Reporter:** vitest `junit` (see `vitest.config.ts`)
- Platform/environment-gated tests (`it.runIf(...)`): **excluded** from this tally (ED-10 §7) so a Windows workstation and the Linux CI runner produce identical files.

## Totals

| Metric | Value |
| --- | --- |
| Test suites | 86 |
| Tests | 1032 |
| Passed | 1032 |
| Failed | 0 |
| Errors | 0 |
| Skipped | 0 |

### Cross-check

- `<failure>`/`<error>` elements vs suite attributes: **consistent**
- `<skipped>` elements vs suite attributes: **consistent**

## Per-suite breakdown

| Suite | Tests | Pass | Fail | Err | Skip |
| --- | --- | --- | --- | --- | --- |
| `test/bidi-client/kinetic-input.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/bidi-client/network.test.ts` | 14 | 14 | 0 | 0 | 0 |
| `test/bidi-client/page.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/bidi-client/script.test.ts` | 11 | 11 | 0 | 0 | 0 |
| `test/cli/awg.test.ts` | 10 | 10 | 0 | 0 | 0 |
| `test/crawler/auth.test.ts` | 16 | 16 | 0 | 0 | 0 |
| `test/crawler/orchestrator.test.ts` | 37 | 37 | 0 | 0 | 0 |
| `test/crawler/session-auth.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/demo/server.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/desktop/chrome-cdp.test.ts` | 7 | 7 | 0 | 0 | 0 |
| `test/desktop/macos-ax.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/desktop/mcp-desktop-tools.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/desktop/session-capture.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/desktop/uia-advanced-actions.test.ts` | 7 | 7 | 0 | 0 | 0 |
| `test/desktop/uia-daemon.test.ts` | 1 | 1 | 0 | 0 | 0 |
| `test/e2e/real-app.test.ts` | 8 | 8 | 0 | 0 | 0 |
| `test/eval/github-eval.test.ts` | 5 | 5 | 0 | 0 | 0 |
| `test/eval/runner.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/eval/task1.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/eval/task2.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/eval/task3.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/eval/task4.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/eval/task5.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/extract-behavior/behavior.test.ts` | 15 | 15 | 0 | 0 | 0 |
| `test/extract-discovery/discovery.test.ts` | 25 | 25 | 0 | 0 | 0 |
| `test/extract-state/ax-id.test.ts` | 15 | 15 | 0 | 0 | 0 |
| `test/extract-state/barrier.test.ts` | 5 | 5 | 0 | 0 | 0 |
| `test/extract-state/convergence.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/extract-state/declared.test.ts` | 36 | 36 | 0 | 0 | 0 |
| `test/extract-state/observed.test.ts` | 36 | 36 | 0 | 0 | 0 |
| `test/extract-state/probe-element.test.ts` | 16 | 16 | 0 | 0 | 0 |
| `test/extract-state/state-materialize.test.ts` | 26 | 26 | 0 | 0 | 0 |
| `test/extract-structure/structural.test.ts` | 16 | 16 | 0 | 0 | 0 |
| `test/extract-visual/interpret.test.ts` | 143 | 143 | 0 | 0 | 0 |
| `test/extract-visual/layout-box.test.ts` | 16 | 16 | 0 | 0 | 0 |
| `test/extract-visual/occlusion-spatial.test.ts` | 16 | 16 | 0 | 0 | 0 |
| `test/extract-visual/patterns.test.ts` | 14 | 14 | 0 | 0 | 0 |
| `test/extract-visual/regression.test.ts` | 8 | 8 | 0 | 0 | 0 |
| `test/extract-visual/tokens.test.ts` | 22 | 22 | 0 | 0 | 0 |
| `test/extract-visual/visual.test.ts` | 26 | 26 | 0 | 0 | 0 |
| `test/graph/graph.test.ts` | 11 | 11 | 0 | 0 | 0 |
| `test/graph/multi-viewport.test.ts` | 12 | 12 | 0 | 0 | 0 |
| `test/graph/patterns-query.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/graph/query-visualstyle.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/graph/query.test.ts` | 37 | 37 | 0 | 0 | 0 |
| `test/graph/security.test.ts` | 11 | 11 | 0 | 0 | 0 |
| `test/graph/state-id.test.ts` | 17 | 17 | 0 | 0 | 0 |
| `test/graph/traversal.test.ts` | 40 | 40 | 0 | 0 | 0 |
| `test/mobile/mcp-mobile-tools.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/mobile/mobile-clients.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/pr-8d/regression-net.test.ts` | 5 | 5 | 0 | 0 | 0 |
| `test/pr-8e/conditional-marker-transition.test.ts` | 8 | 8 | 0 | 0 | 0 |
| `test/pr-8f/convergence-trace.test.ts` | 1 | 1 | 0 | 0 | 0 |
| `test/pr-8g/auth-transition.test.ts` | 8 | 8 | 0 | 0 | 0 |
| `test/pr-8g/choose-dropdown.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/pr-8g/focus-truthfulness.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/pr-8g/trigger-matrix.test.ts` | 33 | 33 | 0 | 0 | 0 |
| `test/pr-8h/trigger-truthfulness-behavioral.test.ts` | 13 | 13 | 0 | 0 | 0 |
| `test/pr-8i/choose-dropdown-axid.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/pr-8i/convergence-target.test.ts` | 1 | 1 | 0 | 0 | 0 |
| `test/pr-8i/real-bidi-auth.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/pr-8i/real-bidi-choose-dropdown.test.ts` | 2 | 2 | 0 | 0 | 0 |
| `test/security/authorization-audit.test.ts` | 5 | 5 | 0 | 0 | 0 |
| `test/security/enforcement-gateway.test.ts` | 17 | 17 | 0 | 0 | 0 |
| `test/security/posture.test.ts` | 18 | 18 | 0 | 0 | 0 |
| `test/server/crawl-jobs.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/server/invoke.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/server/mcp-diagnostics.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/server/mcp-server.test.ts` | 38 | 38 | 0 | 0 | 0 |
| `test/server/naming-drift.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/server/patterns-server.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/server/server.test.ts` | 25 | 25 | 0 | 0 | 0 |
| `test/server/substrate-info.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/store/provenance.test.ts` | 6 | 6 | 0 | 0 | 0 |
| `test/store/sqlite-store.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/store/store.test.ts` | 9 | 9 | 0 | 0 | 0 |
| `test/substrate/desktop-normalizer.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/substrate/desktop-surface.test.ts` | 2 | 2 | 0 | 0 | 0 |
| `test/substrate/mobile-normalizer.test.ts` | 4 | 4 | 0 | 0 | 0 |
| `test/substrate/mobile-surface.test.ts` | 2 | 2 | 0 | 0 | 0 |
| `test/substrate/registry.test.ts` | 2 | 2 | 0 | 0 | 0 |
| `test/substrate/substrate-visual.test.ts` | 2 | 2 | 0 | 0 | 0 |
| `test/substrate/web-adapter.test.ts` | 3 | 3 | 0 | 0 | 0 |
| `test/substrate/web-cdp-surface.test.ts` | 5 | 5 | 0 | 0 | 0 |
| `test/verification/targets.test.ts` | 5 | 5 | 0 | 0 | 0 |
| `test/viewer/viewer.test.ts` | 11 | 11 | 0 | 0 | 0 |

## Interpreting failures

A non-zero failure count is **not automatically a regression**. Per PR-8j T2,
the substrate-gated suites **hard-fail by design** when `AWG_REAL_BIDI` is
unset or geckodriver is unreachable on `127.0.0.1:4444`. The complete list
(ED-09 §6 — no prose may enumerate a subset):

- `test/pr-8i/real-bidi-auth.test.ts`
- `test/pr-8i/real-bidi-choose-dropdown.test.ts`
- `test/server/invoke.test.ts` (PR-8i T2 posture: gated on `AWG_REAL_BIDI`)
- `test/pr-8f/convergence-trace.test.ts` (requires geckodriver on 4444)
- `test/e2e/real-app.test.ts` (also requires `AWG_CONVERGENCE_URL`, served by
  the synthetic demo server)

They are mandatory and never silently skipped. A fully green run therefore
requires the substrate CI provides (Firefox + geckodriver under Xvfb, plus
the synthetic demo server for `AWG_CONVERGENCE_URL`).

| Context | Expected result |
| --- | --- |
| CI (`Constitutional gates`) | 0 failures, 0 errors |
| Local workstation without the BiDi substrate | BiDi/E2E suites fail by design |
