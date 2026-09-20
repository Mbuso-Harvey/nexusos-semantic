# Multi-Agent Orchestration Architecture

> **How to orchestrate multiple Copilot agents working together on the same project — with anti-hallucination guardrails, role definitions, and deterministic quality gates.**

Part of the [Copilot Project Methodology](./README.md) suite.
Prerequisite reading: [`05-agent-methodology-playbook.md`](./05-agent-methodology-playbook.md)

---

## Table of Contents

1. [Why Multi-Agent?](#why-multi-agent)
2. [Level 1: Simple Sequential Loop](#level-1-simple-agent-loop)
3. [Level 2: Multi-Agent Team with Defined Roles](#level-2-medium--multi-agent-team)
4. [Level 3: Orchestrated Agent Graph](#level-3-advanced--orchestrated-agent-graph)
5. [The Anti-Hallucination Guardrail System](#the-anti-hallucination-guardrail-system)
6. [Tech Stack & Implementation](#tech-stack--implementation)
7. [Migration Path: Level 1 → 2 → 3](#migration-path)

---

## Why Multi-Agent?

A single agent following the methodology playbook can deliver 96.5% completion on a complex project. But single agents have limits:

| Limitation | Multi-Agent Solution |
|---|---|
| One phase at a time | Parallel phases by different agents |
| No built-in verification | Dedicated Reviewer/Verifier role |
| Human must review everything | Verifier agent catches drift, false claims |
| Slow on large projects | Workers parallelize independent work |
| No challenge to assumptions | Devil's Advocate role questions decisions |

The goal is NOT to replace the single-agent methodology. It's to scale it — same principles, more agents, parallel execution, with verification.

---

## Level 1: Simple Agent Loop

### Structure

```
Human (Executive)
    │
    │  "Start a new session. Here's the project."
    ▼
Agent Session 1
    │  Reads 6 docs → Plans → Implements → Commits → Pushes → Updates STATUS.md
    │
Agent Session 2 (next session, same or different agent)
    │  Reads STATUS.md → Continues → Commits → Pushes → Updates STATUS.md
    │
Agent Session N...
```

### How It Works

1. **Human creates sessions** — one at a time, sequentially
2. **Each session reads STATUS.md** — knows exactly where to continue
3. **The 6-document ritual** — prevents hallucination and drift
4. **The tracker is the single source of truth** — every claim maps to a tracker item
5. **Typecheck + build as quality gates** — deterministic, cannot be bypassed

### When to Use

- Solo projects
- Single developer with Copilot assistance
- Learning the methodology
- Projects where phases are tightly coupled (can't parallelize)

### Guardrails

| Problem | How Level 1 Handles It |
|---------|----------------------|
| Agent claims DONE but didn't push | Tracker must be updated AFTER push — human verifies on GitHub |
| Agent skips hard items | STATUS.md documents blockers honestly |
| Agent invents features | Constitution defines anti-scope |
| Agent breaks architecture | Constitution defines invariants |
| Code doesn't compile | Typecheck is run before marking DONE |

**Status: PROVEN.** This is what delivered 96.5% on ai-content-processor.

---

## Level 2: Medium — Multi-Agent Team with Defined Roles

### Structure

```
                              HUMAN (Executive)
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
            ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
            │  ARCHITECT   │ │ IMPLEMENTER │ │  REVIEWER    │
            │  (Planner)   │ │  (Worker)   │ │ (Verifier)   │
            └───────┬──────┘ └──────┬──────┘ └──────┬──────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  QUALITY GATES    │
                          │  Typecheck·Build  │
                          └─────────┬─────────┘
                                    │
                          ┌─────────▼─────────┐
                          │   INTEGRATOR      │
                          │ (Merge + Deploy)  │
                          └───────────────────┘
```

### Role Definitions

#### 1. ARCHITECT (Planner)

**Responsibility:** Creates the 6 documents, tracker, and design system. Does NOT write implementation code.

**Input:** Project requirements from the Human.

**Output:**
- `PROJECT_CONSTITUTION.md` — binding rules and invariants
- `docs/MASTER_PLAN.md` — complete scope organized by phase
- `docs/ROADMAP.md` — priority and sizing
- `docs/BUILD_PLAN.md` — how to build each phase
- `docs/EXECUTIVE_DECISIONS.md` — binding decisions vault
- Tracker file — every implementation item with IDs, phases, inspirations

**Tool Profile:**
- Full read/write access
- Can create files, edit documents
- Has `web_search` for design research
- Does NOT commit implementation code — documents only

**Key Instruction:**
```
You are the ARCHITECT. Your job is to PLAN, not to build.

1. Read the project requirements thoroughly.
2. Create the 6 mandatory documents.
3. Create a detailed tracker with every implementation item.
4. For UI: pick 3 inspirations, assign ownership, write exact specs.
5. Commit each document as it's completed.
6. Your output is the PLAN — Workers will implement it.

CRITICAL: Do NOT write implementation code. Your value is in the plan.
```

#### 2. IMPLEMENTER (Worker)

**Responsibility:** Builds one assigned phase. Follows the tracker. Commits and pushes every logical unit.

**Input:** A phase assignment from the Human or Orchestrator, with:
- Specific tracker items to implement
- Files they OWN (no other Worker touches these files)
- The 6 documents for context
- Interface contracts from `packages/ui` (shared types)

**Output:**
- Commits implementing the assigned tracker items
- Updated tracker (their items only)
- Updated STATUS.md (their phase section)
- Handoff notes for any tribal knowledge

**Tool Profile:**
- Full toolset for their assigned files only
- Typecheck on their package
- Can read (not write) files owned by other Workers
- Cannot modify Constitution, Master Plan, or Executive Decisions

**Key Instruction:**
```
You are an IMPLEMENTER assigned to Phase [N]: [phase name].

YOUR FILES (only touch these):
- [list of files and directories]

YOUR TRACKER ITEMS:
- [list of tracker IDs]

RULES:
1. Follow the 6-document ritual before starting
2. Implement ONE tracker item at a time
3. Commit + push after EVERY item
4. Update tracker immediately after each push
5. NEVER touch files outside your assigned scope
6. If you need a new shared type, add it to packages/ui and notify others
7. If blocked, document in STATUS.md and move to next item
```

#### 3. REVIEWER (Verifier)

**Responsibility:** Verifies that Implementer claims are TRUE. Checks for drift, quality, and architectural violations. This is the "trust but verify" role.

**Input:**
- Commits from Implementers
- The tracker (claimed DONE items)
- The Constitution (architectural invariants)

**Output:**
- Review comments on PRs
- Drift alerts (when implementation diverges from spec)
- Quality reports (which items pass/fail verification)
- Rejection of false DONE claims

**Tool Profile:**
- READ-ONLY access to all files
- Can run typecheck, build, lint
- Can read git history
- Can comment on PRs
- CANNOT modify code

**Key Instruction:**
```
You are the REVIEWER. Your job is to VERIFY, not to build.

For EVERY commit or PR from an Implementer:

1. CHECK THE CLAIM:
   - Does the commit exist on GitHub?
   - Does it actually implement the tracker item claimed?
   - Is the tracker updated?

2. CHECK QUALITY:
   - Does typecheck pass?
   - Are touch targets 40px minimum?
   - Are accessibility labels present?
   - Does it work in both light and dark mode?

3. CHECK FOR DRIFT:
   - Does the implementation match the spec?
   - Are there architectural violations?
   - Were any Executive Decisions downgraded?

4. REPORT:
   - APPROVE: Everything checks out → approve the PR
   - REJECT: Issues found → comment with specific problems
   - DRIFT ALERT: Implementation diverged from spec → alert Human

CRITICAL: You are SKEPTICAL by design. Trust nothing without verification.
```

#### 4. INTEGRATOR

**Responsibility:** Merges verified branches, resolves conflicts, runs full test suite, ensures coherence.

**Input:** Approved PRs from the Reviewer.

**Output:** Merged main branch, passing CI/CD, deployed (if applicable).

**Tool Profile:**
- Git merge, rebase
- Full project typecheck and build
- Can resolve simple conflicts
- Escalates complex conflicts to Human

### Communication Flow

```
1. Architect completes plan → pushes to main
2. Human assigns phases:
   - Implementer A: Phase 3 (files: apps/mobile/src/app/*)
   - Implementer B: Phase 4 (files: packages/agent-runtime/*)
3. Both work simultaneously — no file overlap, no conflicts
4. After each commit, Reviewer checks:
   - "Does the commit exist? Does typecheck pass? Is the tracker updated?"
5. Reviewer approves → Integrator merges to main
6. Reviewer rejects → Implementer fixes → re-review
```

### File Ownership Map (Critical for Conflict Prevention)

```
packages/ui/src/**          ← SHARED — any Worker can ADD types (coordinate first)
packages/ai-core/src/**     ← Worker B (Phase 4)
packages/agent-runtime/**   ← Worker B (Phase 4)
apps/mobile/src/app/**      ← Worker A (Phase 3)
apps/mobile/src/components/** ← Worker A (Phase 3)
apps/mobile/src/theme/**    ← Worker A (Phase 3)
docs/**                     ← SHARED — any Worker can update STATUS.md (their section only)
```

### Guardrails at Level 2

| Problem | Guardrail |
|---------|-----------|
| Agent claims DONE but didn't push | Reviewer checks GitHub for actual commits |
| Agent silently skips hard items | Reviewer cross-references tracker items with implementations |
| Agent introduces drift from spec | Reviewer checks against Constitution + Master Plan |
| Agent invents features | Worker scoped to specific tracker items |
| Code doesn't compile | Deterministic gate: typecheck before merge |
| Merge conflicts | File ownership prevents overlap |
| False DONE in tracker | Reviewer verifies every DONE claim |

---

## Level 3: Advanced — Orchestrated Agent Graph

### Structure

```
                         ┌─────────────────────────────────┐
                         │         ORCHESTRATOR            │
                         │  • Goal Decomposer              │
                         │  • Dependency Resolver          │
                         │  • Coordinator                  │
                         │  • Re-planner (when blocked)    │
                         └──────────────┬──────────────────┘
                                        │
            ┌───────────────────────────┼───────────────────────────┐
            │                           │                           │
   ┌────────▼────────┐         ┌───────▼────────┐         ┌───────▼────────┐
   │   WORKER A      │         │   WORKER B     │         │   WORKER C     │
   │  Phase N        │         │  Phase N+1     │         │  Phase N+2     │
   │  (Implementer)  │         │  (Implementer)  │         │  (Implementer) │
   └────────┬────────┘         └───────┬────────┘         └───────┬────────┘
            │                           │                           │
            └───────────────────────────┼───────────────────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │        VERIFIER            │
                          │  • Devil's Advocate        │
                          │  • Cross-reference checker │
                          │  • Drift detector          │
                          │  • Quality auditor         │
                          └─────────────┬─────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │   DETERMINISTIC GATES      │
                          │  Typecheck · Build · Lint │
                          │  Unit Tests · E2E Tests   │
                          │  (CANNOT BE BYPASSED)     │
                          └─────────────┬─────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │      INTEGRATOR            │
                          │  Merge · Resolve · Deploy │
                          └───────────────────────────┘
```

### Role Definitions (Advanced)

#### ORCHESTRATOR

The Orchestrator is NOT an agent that writes code. It's a meta-agent that:
1. Reads the full Master Plan
2. Decomposes it into independent parallelizable sub-goals
3. Assigns sub-goals to Workers with clear file ownership
4. Monitors progress through the shared tracker
5. Re-plans when a Worker reports BLOCKED
6. Coordinates cross-agent communication

**Algorithm (pseudocode):**

```
FUNCTION orchestrate(masterPlan, roadmap):
    subgoals = []
    FOR each phase in masterPlan:
        IF phase has no dependency on in-progress phases:
            subgoals.append({
                phase: phase,
                files: determineFileOwnership(phase),
                trackerItems: getTrackerItems(phase),
                worker: null
            })

    FOR each subgoal in subgoals:
        worker = spawnWorker(subgoal)
        subgoal.worker = worker

    WHILE subgoals.hasPending():
        FOR each subgoal:
            status = checkWorkerStatus(subgoal.worker)
            IF status == "DONE":
                verification = verifier.verify(subgoal)
                IF verification.passed:
                    integrator.merge(subgoal)
                    subgoal.markComplete()
                ELSE:
                    subgoal.worker.sendFeedback(verification.feedback)
            IF status == "BLOCKED":
                replan(subgoal)

    updateTeamStatus(subgoals)
```

**Key Instruction:**
```
You are the ORCHESTRATOR. You do NOT write implementation code.

Your job:
1. Read MASTER_PLAN.md and ROADMAP.md
2. Identify independent sub-goals (different phases, no file overlap)
3. Spawn Worker agents for each sub-goal
4. Assign each Worker: specific tracker items, specific files they OWN
5. After each Worker reports DONE, have the Verifier check their work
6. Only merge when Verifier approves AND quality gates pass
7. If a Worker is BLOCKED, re-plan: reassign, escalate, or skip

CRITICAL: You are the coordinator, not the implementer.
Your value is in decomposition, assignment, and verification.
```

#### VERIFIER (Devil's Advocate)

More aggressive than the Level 2 Reviewer. The Verifier:
- Assumes every DONE claim is FALSE until proven
- Cross-references commits against tracker items
- Tests edge cases the Worker may have missed
- Challenges architectural decisions
- Flags scope creep and drift immediately

**Key Instruction:**
```
You are the VERIFIER. Your default assumption: NOTHING is truly DONE.

For every Worker claim:
1. SKEPTICISM: "Show me the commit. Show me the typecheck. Show me the tracker update."
2. CROSS-REFERENCE: Does the commit ACTUALLY implement the tracker item?
3. EDGE CASES: "What happens when the theme is null? When the list is empty?"
4. DRIFT CHECK: "Did the Worker introduce anything not in the spec?"
5. ARCHITECTURAL AUDIT: "Did they violate any Constitution invariant?"

APPROVE only when ALL checks pass.
REJECT with specific, actionable feedback.
ESCALATE to Human if you detect pattern of false claims.
```

#### DETERMINISTIC QUALITY GATES

These are NOT agents. They are automated checks that CANNOT be bypassed:

```yaml
# .github/workflows/quality-gates.yml
name: Quality Gates
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm typecheck  # FAILS PR if any type error

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm build  # FAILS PR if build fails

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm lint  # FAILS PR if lint errors

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test  # FAILS PR if tests fail
```

**No agent — not the Worker, not the Orchestrator, not even the Human — can merge without these gates passing.**

---

## The Anti-Hallucination Guardrail System

This is the most important section. Every level needs these. They form a layered defense:

### Layer 1: Prevention (Before Work Starts)

| Guardrail | How It Works |
|-----------|-------------|
| **6-Document Ritual** | Agent reads Constitution + Master Plan before any code → understands scope and rules |
| **Tracker Scoping** | Worker is assigned specific tracker items → cannot invent new features |
| **File Ownership** | Worker has write access to specific files only → cannot break other phases |
| **Inspiration Requirements** | For UI: must reference top-3 industry products as inspiration — prevents generic design |

### Layer 2: Verification (During Work)

| Guardrail | How It Works |
|-----------|-------------|
| **Cross-Reference Check** | Verifier checks every DONE claim: "Show me the commit, the typecheck, the tracker update" |
| **Devil's Advocate** | Verifier specifically looks for reasons something ISN'T done — assumes false until proven |
| **Deterministic Gates** | Typecheck, build, lint, unit tests, E2E tests — run by CI, CANNOT be bypassed |
| **Drift Detection** | Verifier compares implementation against Master Plan spec — flags any divergence immediately |
| **Tracker Integrity** | Tracker is the single source of truth — Verifier cross-references it against git history |

### Layer 3: Remediation (When Problems Found)

| Guardrail | How It Works |
|-----------|-------------|
| **Rejection with Feedback** | Verifier REJECTS with specific, actionable items — never just "redo it" |
| **Re-planning** | Orchestrator reassigns blocked work, escalates to Human when needed |
| **Pattern Detection** | If same Worker has 3+ rejections, Verifier escalates to Human — possible agent quality issue |
| **Immutable Audit Trail** | Every commit + tracker update is permanent in git history — no hiding false claims |
| **File Ownership Locks** | No two Workers can write the same file — prevents merge conflicts and overwrites |

### The "Trust Nothing" Verification Checklist

Every Worker DONE claim goes through this checklist. ALL must pass:

```
[ ] COMMIT EXISTS: The commit is visible on GitHub (not just local).
[ ] TRACKER UPDATED: The tracker item is marked DONE with the commit hash.
[ ] TYPECHECK PASSES: `pnpm typecheck` exits with code 0 on that commit.
[ ] BUILD PASSES: `pnpm build` exits with code 0 on that commit.
[ ] LINT PASSES: `pnpm lint` exits with code 0 on that commit.
[ ] TESTS PASS: `pnpm test` exits with code 0 on that commit (if tests exist).
[ ] IMPLEMENTS CLAIM: The diff actually implements what the tracker item says.
[ ] NO DRIFT: No extra files, no unexpected changes, no architectural violations.
[ ] CONSTITUTION CHECK: No Constitution invariant was violated.
[ ] INSPIRATION REFERENCED: For UI items, the inspiration source is cited in the commit.
```

**If ANY checkbox is empty → REJECT. Only when ALL 10 pass → APPROVE.**

---

## Tech Stack & Implementation

### For Level 1 (Single Agent)

**No additional infrastructure needed.** The methodology docs + GitHub tracker + typecheck gate are sufficient. A Human creates sessions, the agent executes.

### For Level 2 (Multi-Agent Team)

**Minimal infrastructure:**
- GitHub repository with branch protection
- Required CI checks (typecheck, build) on PRs
- The 6 documents + tracker in the repo
- Human assigns phases manually

**Session creation:**
- Architect: `create_session` with a planning prompt
- Implementer A: `create_session` with an implementation prompt scoped to specific files
- Implementer B: `create_session` with an implementation prompt scoped to different files
- Reviewer: `create_session` with a read-only verification prompt

### For Level 3 (Orchestrated Graph)

**Additional infrastructure (future):**
- An Orchestrator session that manages worker sessions via `create_session` + `send_session_message`
- A Verifier session that monitors all worker outputs
- GitHub Actions for deterministic quality gates
- Optional: a workflow scheduler (`save_workflow`) for periodic status checks

**The Orchestrator can use these Copilot-native tools:**
- `create_session` — spawn a new worker session with a specific prompt
- `send_session_message` — send feedback or new instructions to a worker
- `get_session` — check worker session status
- `archive_session` — clean up completed workers

**Communication pattern:**
```
Orchestrator → create_session(Worker A, prompt="Implement Phase 3 items...")
Worker A → commits, updates tracker, goes idle
Orchestrator → get_session(Worker A) → sees "idle"
Orchestrator → create_session(Verifier, prompt="Verify Worker A's commits...")
Verifier → approves or rejects
Orchestrator → if rejected: send_session_message(Worker A, feedback="Fix...")
```

### Recommended: Start at Level 2, Build Toward Level 3

Level 2 gives you the most value for the least complexity:
- Clear role separation
- Parallel execution
- Verification built in
- No custom infrastructure needed

Level 3 adds value when you have 3+ workers running simultaneously and need automated coordination. The Orchestrator becomes necessary when manual coordination is the bottleneck.

---

## Migration Path: Level 1 → 2 → 3

```
WEEK 1-2: Level 1
  └─ Run one or two projects with single agents using the methodology
  └─ Confirm the 6-document system works for your projects
  └─ Confirm the tracker is detailed enough for others to follow

WEEK 3-4: Level 2 (Manual)
  └─ On your next project, have an agent be the Architect (plan only)
  └─ Review the plan, then spawn 2 Implementers for parallel phases
  └─ Spawn a Reviewer to verify each Implementer's output
  └─ Document what worked / what didn't

WEEK 5+: Level 3 (Automated)
  └─ Create an Orchestrator agent that manages the full flow
  └─ Add deterministic quality gates (CI/CD)
  └─ Run a project end-to-end with minimal Human intervention
  └─ Iterate on the verification checklist
```

---

## Summary: The Three Levels at a Glance

| Aspect | Level 1 (Simple) | Level 2 (Team) | Level 3 (Orchestrated) |
|--------|-----------------|----------------|----------------------|
| **Agents** | 1 (does everything) | 2-4 (Architect, Implementer, Reviewer, Integrator) | 5+ (Orchestrator, Workers, Verifier, Gates, Integrator) |
| **Parallelism** | None | 2-3 phases parallel | Full parallel with dependency resolution |
| **Verification** | Human | Reviewer agent | Verifier agent + deterministic gates |
| **Coordination** | Human | Human assigns phases | Orchestrator auto-assigns |
| **Anti-Drift** | Constitution only | Reviewer checks spec | Verifier + Devil's Advocate |
| **Infrastructure** | None | GitHub CI | GitHub CI + Orchestrator session |
| **Best for** | Solo, learning, small projects | Team of 2-4, medium projects | Large projects, 3+ simultaneous workers |

**The secret: The methodology documents (Constitution, Master Plan, Tracker) are the foundation for ALL levels.** Without them, no amount of orchestration prevents hallucination. With them, even Level 1 delivers 96.5% completion.

---

*Document v1.0 — Part of the [Copilot Project Methodology](https://github.com/Mbuso-Harvey/copilot-project-methodology) suite. Private repository.*