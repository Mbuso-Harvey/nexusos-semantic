# 02 — Starting a Brand New Project (Greenfield)

> **Use this when:** There is no code, no repository, no documentation. You are building
> from absolute zero. This is the complete blueprint for project initialization.

---

## Standard Operating Procedure: ALWAYS Start in Plan Mode

The canonical workflow for starting a new project is identical to taking over an existing one:

**Plan mode → Explore → Create plan with subatomic tasks → Open in canvas widget → User approves → Autopilot**

See `01-taking-over-a-project.md` § "Standard Operating Procedure: Session Startup" for the complete pipeline. The plan widget is non-negotiable — even for greenfield projects, the user must see and approve the plan before any code is written.

---

## Phase 0: Project Scaffolding (First Session)

### Step 0.1: Create the Repository

```bash
gh repo create owner/project-name --public --description "Brief description"
git clone https://github.com/owner/project-name.git
cd project-name
```

### Step 0.2: Create the Mandatory Document Skeleton

Every project MUST have these six documents. They are non-negotiable. Create them
in this exact order:

```
project-root/
├── PROJECT_CONSTITUTION.md    ← The law
├── docs/
│   ├── MASTER_PLAN.md         ← Numbered phases, what ships when
│   ├── STATUS.md              ← Living completion tracker
│   ├── EXECUTIVE_DECISIONS.md ← Binding product decisions
│   ├── BUILD_PLAN.md          ← Concrete build order + dependencies
│   └── ROADMAP.md             ← Timeline view
```

**Why these six?** Any agent joining later reads these six files and knows
EVERYTHING they need: the rules, the plan, the current state, the locked
decisions, the build order, and the timeline. Six files. Complete context.

### Step 0.3: PROJECT_CONSTITUTION.md

This is the first document you create. It is the highest authority.

Template:
```markdown
# Project Constitution — [PROJECT NAME]

## 1. Project Identity
- **What we're building**: [One paragraph — clear enough that anyone understands]
- **What we're NOT building**: [Scope boundaries — prevents feature creep]
- **Target users**: [Who is this for?]

## 2. Architectural Invariants
Rules that CANNOT be violated:
1. [e.g., UI code depends on contracts, not concrete LLM vendors]
2. [e.g., Local-first does not mean local-only]
3. [e.g., All user data encrypted at rest]

## 3. Commit Discipline
- Format: type(scope): imperative description
- One logical change per commit
- Push after every commit
- Co-authored-by trailer required

## 4. Technology Stack
- [Language, framework, package manager, build tool]
- [Database, storage, deployment target]
- [Key libraries and why they were chosen]

## 5. Branch Strategy
- feat/P{phase}-{description} for feature phases
- fix/{description} for bug fixes
- Never commit directly to main

## 6. Quality Gates
- TypeScript: 0 errors before commit
- Build: 0 warnings before commit
- Tests: all passing before merge
```

### Step 0.4: docs/MASTER_PLAN.md

Numbered phases. Each phase is a shippable increment.

Template:
```markdown
# Master Plan — [PROJECT NAME]

## Phase Structure
Each phase: P{number} — {name}
- Clear completion criteria
- Depends on prior phases (unless noted)
- Produces a shippable increment

## P0: Foundation
**Goal**: Project compiles, basic structure exists
**Deliverables**:
- [ ] Monorepo structure (if applicable)
- [ ] Package manager configured
- [ ] TypeScript strict mode
- [ ] Build pipeline working
**Dependencies**: None
**Estimated**: 1-2 sessions

## P1: Core Contracts
**Goal**: Interfaces and types defined
...
```

### Step 0.5: docs/STATUS.md

Updated after EVERY work session.

Template:
```markdown
# Project Status

**Last updated**: [DATE]
**Current phase**: P0 — Foundation
**Overall progress**: 0%

## What's Done
- [x] Repository created
- [x] Constitution drafted

## What's In Progress
- [ ] P0: Foundation setup

## What's Blocked
(None yet)

## Recent Commits
- abc1234 docs: initial project constitution
```

### Step 0.6: docs/EXECUTIVE_DECISIONS.md

The locked decisions vault.

Template:
```markdown
# Executive Decisions

**CRITICAL**: Decisions here are BINDING. Implementation difficulty does not
justify changing them. If blocked, document the blocker and request guidance.

## ED-01: [Decision Title]
**Date**: [DATE]
**Decision**: [What was decided]
**Rationale**: [Why]
**Impact**: [What it affects]
**Alternatives Considered**: [What was rejected and why]
```

### Step 0.7: docs/BUILD_PLAN.md

Concrete build order with dependency graph.

Template:
```markdown
# Build Plan

## Dependency Graph
P0 Foundation → P1 Core Contracts → P2+ Features

## Build Commands
- Install: `pnpm install`
- TypeScript: `pnpm tsc --noEmit`
- Build: `pnpm build`
- Test: `pnpm test`
```

### Step 0.8: docs/ROADMAP.md

Timeline view.

Template:
```markdown
# Roadmap

## Phase 1 — Foundation (Sessions 1-3)
- P0: Repository, constitution, build pipeline
- P1: Core contracts, type system

## Phase 2 — Core Features (Sessions 4-10)
...

## Phase 3 — Polish + Launch (Sessions 11-15)
...
```

---

## Phase 1: Technical Foundation

### Step 1.1: Initialize Tech Stack

```bash
pnpm init
# Configure tsconfig.json strict mode
# Set up workspace structure
```

### Step 1.2: Create Design Token System

Before any UI code, create tokens:

```css
/* packages/ui/src/tokens.css */
:root {
  --bg: #ffffff;
  --bg-surface: #f7f7f8;
  --fg: #1a1a2e;
  --border: #e5e5ea;
  --accent: #6366f1;
  --danger: #e5484d;
  --space-standard: 16px;
  --radius-lg: 12px;
  --text-base: 14px;
}

.dark {
  --bg: #0d1016;
  --bg-surface: #161922;
  /* ... all dark variants ... */
}
```

### Step 1.3: Verify Foundation

```bash
pnpm install && pnpm build   # MUST: 0 errors, 0 warnings
```

---

## Phase 2: Implementation Tracker

Break the Master Plan into atomic items:

```markdown
| ID | Task | Plan Reference | Status | Inspiration Source |
|---|---|---|---|---|
| P0.1.1 | Initialize monorepo | MASTER_PLAN P0 | ✅ DONE | — |
| P1.2.1 | Define core interfaces | MASTER_PLAN P1 | ⬜ PENDING | — |
```

**Rules**: Each item is one verifiable thing. UI items MUST name design inspiration (Gemini, ChatGPT, or Copilot). Open in canvas side panel.

---

## Phase 3+: The Development Rhythm

### The Complete Cycle (Execute for EVERY change)

```
1. SELECT TASK — query SQL for ready todos, pick from tracker, mark 🚧 IN PROGRESS
2. READ CONTEXT — relevant MASTER_PLAN section, EXECUTIVE_DECISIONS constraints
3. IMPLEMENT — write code, verify icons exist, use var() with fallbacks
4. VERIFY — pnpm tsc (0 errors) → pnpm build (0 warnings) → fix → repeat
5. COMMIT — git add -A; git commit -m "type(scope): description" + Co-authored-by
6. PUSH — git push
7. UPDATE — tracker ✅ DONE, SQL done, STATUS.md if phase changed
8. NEXT TASK — return to step 1
```

### Document Update Frequency

| Document | When |
|---|---|
| **Tracker** | After EVERY commit |
| **SQL todos** | After EVERY commit |
| **STATUS.md** | End of session, or phase/blocker change |
| **EXECUTIVE_DECISIONS.md** | When new binding decision made |
| **MASTER_PLAN.md** | When scope changes (rare) |
| **ROADMAP.md** | When timelines shift (rare) |

### Unbreakable Rules

1. Never skip the build step
2. Never accumulate unpushed commits
3. Never silently change an executive decision
4. Never invent design — cite a real product
5. Never idle on a blocker — document and move on

---

## Design System: Copy, Don't Invent

### Choose Three Inspiration Products

| Product | Best For |
|---|---|
| **Gemini** (Google) | Home screens, gradients, glassmorphism, color systems, aura effects |
| **ChatGPT** (OpenAI) | Tab bars, typing indicators, message bubbles, file upload, voice UI |
| **Copilot** (GitHub) | Sidebar navigation, settings panels, pack management, code views |

### Before Any UI Code

1. For each UI element, decide which product to copy
2. Document in tracker's "Inspiration Source" column
3. Create tokens with colors sampled from those products
4. Build components referencing real screenshots

### Prohibited

- Making up colors — sample from real products
- Inventing icon layouts — copy from ChatGPT sidebar, Copilot settings
- Guessing spacing — use the 4px scale from all three products
- Designing from scratch — every element has a reference

---

## Quality Gates Per Phase

- [ ] `pnpm tsc --noEmit`: 0 errors
- [ ] `pnpm build`: 0 errors, 0 warnings
- [ ] All phase items ✅ in tracker
- [ ] All commits pushed
- [ ] STATUS.md updated
- [ ] No hardcoded colors without `var()` fallback
- [ ] 40px+ touch targets (UI phases)
- [ ] aria-labels on icon elements (UI phases)
- [ ] Reduced motion + high contrast working (UI phases)

---

## First Session Checklist

After session 1 on a greenfield project:

- [ ] Repository created on GitHub
- [ ] All 6 mandatory documents exist (even if skeletal)
- [ ] Project builds with 0 errors
- [ ] Implementation tracker created and opened in canvas
- [ ] SQL todos initialized
- [ ] First commit pushed

---

*Part of the [Copilot Project Methodology](./README.md).*