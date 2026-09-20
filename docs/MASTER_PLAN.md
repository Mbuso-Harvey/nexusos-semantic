# Master Plan — Agent Web Graph

> **Source of truth:** `docs/REQUIREMENTS.md` (the original brief,
> added in PR-2). Where any phase conflicts with the brief, the
> brief wins until an addendum is filed.

## Phase Structure
Each phase is a subatomic PR per the working methodology. A phase
ships only when its PR is merged to main with all quality gates
green (§6 of `PROJECT_CONSTITUTION.md`).

## P0 — Foundation (PR-1)
**Goal:** repo exists; the 6 mandatory methodology documents are
on main; no source code yet.
**Deliverables:** PROJECT_CONSTITUTION.md, docs/MASTER_PLAN.md,
docs/STATUS.md, docs/EXECUTIVE_DECISIONS.md, docs/BUILD_PLAN.md,
docs/ROADMAP.md, README.md, .gitignore.
**Dependencies:** none.
**Estimate:** 1 session.

## P1 — Original brief on main (PR-2)
**Goal:** the brief is canonical and unmodifiable on main.
**Deliverables:** docs/REQUIREMENTS.md, MASTER_PLAN citation update.
**Dependencies:** P0.
**Estimate:** 1 session.

## P2 — Source tree imported (PR-3)
**Goal:** all 21 stages of local code on main, tested, building.
**Deliverables:** full src/, test/, demo/ tree; package.json;
tsconfig.json; vitest.config.ts; scripts/; the 6-extractor
Crawler; Graph contract; Store; JSON-RPC + MCP stdio server;
`awg` CLI; eval harness + 5 demo tasks; synthetic SaaS demo.
**Dependencies:** P1.
**Estimate:** 1-2 sessions.
**Test gate:** `pnpm install && pnpm exec tsc --noEmit && pnpm test && pnpm run check-env`.

## P3 — Working methodology on main (PR-4)
**Goal:** the 6 methodology files the user pointed at are
checked in with attribution.
**Deliverables:** docs/methodology/ containing the 6 source
methodology files + SOURCE.md.
**Dependencies:** P2.
**Estimate:** 1 session.

## P4 — Gap analysis on main (PR-5)
**Goal:** the 5-layer audit is committed; STATUS.md reflects
active gap-closure work.
**Deliverables:** docs/GAP-ANALYSIS.md, docs/STATUS.md update.
**Dependencies:** P3.
**Estimate:** 1 session.

## P5+ — Gap closure (PR-6..PR-N, planned one-at-a-time)
**Goal:** close the 5 gaps surfaced by the audit, in the order
binding in EXECUTIVE_DECISIONS.md.
**Phases (one PR each, planned in their own subatomic plans):**
- **P5 / PR-6:** ED-04 — A11y tree is a tree
  (add `parentAxId` to AxNode; update structural extractor;
  update query predicates; tests).
- **P6 / PR-7:** ED-03 — Pages carry parent/child edges
  (add `parentPageId` to Page; update Crawler discovery;
  expose `reachableFrom` predicate on a hierarchical graph;
  tests).
- **P7 / PR-8:** ED-01 — Interaction states are first-class
  graph nodes (add State node type; convert transition log
  entries to State→State edges with triggers; tests).
- **P8 / PR-9:** ED-02 — Capabilities are executable
  (replace `graph.act` decision-only return with `graph.invoke`
  that performs the action via BiDi; server owns the BiDi
  session; tests).
- **P9 / PR-10:** ED-05 — No silent substitutions
  (audit, ratified; the running system has no remaining
  unrecorded gaps; GAP-ANALYSIS.md is the single source of
  truth for the original brief ↔ current code delta).
**Dependencies:** P4. Each subsequent gap-closure PR
depends on the previous one.
**Estimate:** 1 session each, per the methodology's
"atomic, independently testable PR" rule.
