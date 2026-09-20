# Evidence Ledger — real-target validation

> **Purpose.** Every public claim that NexusOS Semantic works against real
> applications must trace to a run recorded here. The ledger is
> machine-generated; hand-edits are prohibited (ED-09 §3).

## Why this exists

The launch-readiness audit found synthetic-only functional coverage and
mutually inconsistent hand-written test tallies. The ratified strategy is
**layered testing with recorded evidence**:

1. **Owned synthetic applications** (`demo/saas`) — deterministic, CI-gated.
2. **Self-hosted real OSS applications** (OWASP Juice Shop, httpbin) —
   real-world complexity, legally ours, pinned by recorded image digest.
3. **A tiny permissioned-public set** (example.com, W3C ARIA APG) —
   hard-budgeted evidence against the live web; never a release gate.
4. **Authorized design partners** — a consenting company's controlled
   environment under a signed Authorization-to-Test (`ATT-TEMPLATE.md`).

A bug bounty is explicitly **not** the test strategy (ED-09 §5): it tests
third-party software rather than ours, registration requires a legal person,
and automated crawling is out of scope on most programs.

## Authorization classes (ED-09 §2)

| Class | Release gate? | Definition |
| --- | --- | --- |
| `owned` | yes | in-repo synthetic applications we operate |
| `self-hosted-oss` | yes | real OSS, self-hosted by us in containers on localhost |
| `permissioned-public` | no — evidence only | fixed, hard-budgeted public pages; robots.txt recorded before every crawl |
| `design-partner` | as the ATT specifies | controlled environment under a signed ATT |

Crawling arbitrary public sites is **prohibited** (ED-09 §2).

## Targets in this repository

| Slug | Class | Gating | Budget cap |
| --- | --- | --- | --- |
| `demo-saas` | owned | gate | 6 pages |
| `juice-shop` | self-hosted-oss | gate | 3 pages |
| `httpbin` | self-hosted-oss | gate | 3 pages |
| `example-com` | permissioned-public | no | 1 page |
| `aria-apg` | permissioned-public | no | 2 pages |

The binding authorization basis for each target is the `authorizationBasis`
field of `verification/targets/<slug>.json`.

## Running

Prerequisites: Node ≥ 24 + pnpm; Firefox and geckodriver listening on
`127.0.0.1:4444` (the crawl substrate); Docker for `self-hosted-oss`
targets.

```bash
node scripts/run-ledger.mjs                # all targets
node scripts/run-ledger.mjs --target demo-saas
```

Exit code is non-zero **only** when a *gating* target fails. A failure of a
`permissioned-public` target is recorded as evidence, but cannot fail the
run (their sites change without notice; that is expected). Skips (no
geckodriver, no Docker) do not fail a local run; pass `--strict` to make
them failures, as the nightly CI job does. `--list` prints the target table.

## What gets recorded

- `verification/results/<slug>.json` — the latest per-target result:
  verdict, thresholds vs. actuals, graph summary, extractor diagnostics,
  authorization snapshot (robots.txt record / image digest), environment.
- `verification/LEDGER.md` — regenerated from the results; the summary table
  an auditor reads first.
- `verification/runs/<slug>/<timestamp>/` — full artifacts (graph.json, logs);
  gitignored, retained in CI artifacts.

## Adding a target

1. Create `verification/targets/<slug>.json` — every target MUST declare
   `class`, `authorizationBasis`, a hard `crawl.maxPages` cap, and `expect`
   thresholds. `authoritative: true` means the target can fail the run.
2. Append a note to ED-09 in `docs/EXECUTIVE_DECISIONS.md`.
3. `design-partner` targets additionally require a signed
   `ATT-TEMPLATE.md` agreement filed in the private compliance archive
   before the first run.

## Manifest schema (summary)

```json
{
  "slug": "kebab-case-id",
  "name": "Human-readable name",
  "class": "owned | self-hosted-oss | permissioned-public | design-partner",
  "authoritative": true,
  "authorizationBasis": "why we are allowed to crawl this",
  "target": { "url": "...", "host": "..." },
  "start": { "command": "...", "waitTcp": { "host": "...", "port": 0, "timeoutMs": 0 } },
  "container": { "image": "...", "name": "...", "hostPort": 0, "containerPort": 0, "waitTcp": { } },
  "crawl": { "maxPages": 1, "posture": "autopilot", "authorizeTargets": "host" },
  "expect": { "minPages": 1, "minAxNodes": 1, "minStates": 0, "minEdges": 0, "healthScoreMin": 0, "maxExtractorFailures": 0 },
  "robots": null
}
```
