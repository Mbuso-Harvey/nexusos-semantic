# Evidence Ledger — real-target validation record

> **MACHINE-GENERATED — DO NOT EDIT BY HAND (ED-09 §3).** Regenerated
> deterministically from `verification/results/*.json` by
> `scripts/run-ledger.mjs`. The per-target result files are the
> authoritative record; this table is derived from them.

| Target | Class | Gating | Budget | Verdict | Pages | Ax nodes | States | Health % | Ext. failures | Robots | Image | Ran at (UTC) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| aria-apg | permissioned-public | no | 2p | PASS | 2 | 616 | 14 | 100 | 0 | recorded, allowed | n/a | 2026-09-17T16:04:19.480Z |
| demo-saas | owned | yes | 6p | PASS | 6 | 371 | 50 | 100 | 0 | n/a | n/a | 2026-09-17T16:05:32.340Z |
| example-com | permissioned-public | no | 1p | SKIP | — | — | — | — | — | fetch failed (robots.txt not retrievable (HTTP 404)) | n/a | 2026-09-17T16:06:34.014Z |
| httpbin | self-hosted-oss | yes | 3p | PASS | 2 | 120 | 8 | 100 | 0 | n/a | `sha256:599fe5e50731…` | 2026-09-17T16:06:34.134Z |
| juice-shop | self-hosted-oss | yes | 3p | FAIL | — | — | — | — | — | n/a | `sha256:73c53fbf442e…` | 2026-09-17T16:07:31.128Z |

**Totals:** 3 PASS · 1 FAIL · 1 SKIP · 0 no recorded run.

> ⚠ Gating target(s) recorded FAIL — see the per-target result files and ED-09 §4.

A SKIP records an unmet environmental or authorization precondition (BiDi
substrate down, Docker absent, or a robots.txt refusal). Evidence-only targets
(`permissioned-public`) never affect the nightly gate (ED-09 §4).
