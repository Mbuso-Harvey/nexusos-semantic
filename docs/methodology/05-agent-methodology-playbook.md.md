# THE COPILOT AGENT METHODOLOGY PLAYBOOK — Commercial Edition v2.0

> **The definitive operating system for building production software with GitHub Copilot agents.**
>
> Extracted from the ai-content-processor project: 96.5% completion, 255 tracked items, 40+ commits, zero lost work.
> Author: Harvey Mbuso · License: All rights reserved

---

# VOLUME I: FOUNDATIONS

---

## Chapter 1: The Philosophy of Agent-Driven Development

### 1.1 Why Agents Need a Methodology

Large language models are powerful but chaotic. Without structure, agents hallucinate features that don't belong, downgrade approved capabilities because they're hard, wander the repository looking for something to do, lose context across sessions, and produce wildly inconsistent quality.

This playbook exists because **power without process creates chaos.**

The methodology was battle-tested on the ai-content-processor — a Private Offline Personal AI Computer spanning mobile, desktop, and agent runtime. Over 40+ commits, 255 tracked items, and 96.5% completion, every pattern was refined until repeatable, predictable, and scalable.

### 1.2 The Three Pillars of Agent Success

| Pillar | What It Is | What Happens Without It |
|--------|-----------|------------------------|
| **Visibility** | Live tracker showing every task, status, and percentage | Human has zero idea what's happening. Trust evaporates. |
| **Recoverability** | Every commit pushed immediately + checkpoints + document trail | Session crash = hours of work permanently lost |
| **Continuity** | 6-document ritual + STATUS.md handoff protocol | Each new agent starts from zero, repeats work, creates inconsistency |

### 1.3 The Agent/Human Contract

**Agent promises to:**
1. Read all project documents before any action
2. Create and maintain a visible tracker of ALL work
3. Commit and push after EVERY logical unit
4. Never accumulate local-only changes
5. Leave a complete handoff for the next agent
6. Never silently downgrade or remove approved capabilities

**Human promises to:**
1. Provide clear requirements and binding decisions
2. Review the tracker periodically
3. Approve or reject plans promptly
4. Update EXECUTIVE_DECISIONS.md when scope changes

### 1.4 Chapter Map

| Ch. | Topic | Why It Matters |
|-----|-------|---------------|
| 1 | Philosophy | Understanding WHY before HOW |
| 2 | The 6-Document System | Non-negotiable project artifacts |
| 3 | Session Startup Ritual | What every agent MUST do before writing code |
| 4 | Planning & Tracking | The atomic task tracker methodology |
| 5 | Architecture-First Development | Types vs. runtime, packages vs. apps |
| 6 | Design-by-Reference | Steal from the best — never design from scratch |
| 7 | The Commit-Push-Tracker Cycle | The atomic rhythm of productive work |
| 8 | Tool Usage & Power Patterns | Maximizing the Copilot environment |
| 9 | Error Recovery & Debugging | Common pitfalls and exact solutions |
| 10 | Handoff Protocol | Leaving the project better than you found it |
| 11 | Quality Standards & Checklists | The non-negotiable quality bar |
| 12 | Prompt Templates | Battle-tested copy-paste prompts |
| 13 | Scaling Across Agents | Multi-agent coordination, parallel work |
| 14 | The Golden Rules | One-page reference card |
| App. A | Real Examples from ai-content-processor | Annotated tracker, commits, decisions |
| App. B | Tool Cheat Sheets | PowerShell, Git, TypeScript, React Native |
| App. C | Troubleshooting Guide | 25+ common errors with exact fixes |

---

## Chapter 2: The 6-Document System

### 2.1 The Non-Negotiable Project Structure

```
project-root/
├── PROJECT_CONSTITUTION.md        ← THE LAW (changes rarely)
├── docs/
│   ├── MASTER_PLAN.md             ← THE BLUEPRINT (all phases, features)
│   ├── STATUS.md                  ← THE HEARTBEAT (updated EVERY session)
│   ├── EXECUTIVE_DECISIONS.md     ← THE VAULT (binding decisions, unchangeable)
│   ├── ROADMAP.md                 ← THE COMPASS (priority + sizing)
│   └── BUILD_PLAN.md              ← THE MANUAL (how each phase is built)
```

These six documents ARE the project's memory. Without them, every agent session starts from zero knowledge. With them, any agent can onboard in under 5 minutes.

### 2.2 Document #1: PROJECT_CONSTITUTION.md — THE LAW

**Read:** First, every session, fully
**Update:** Rarely — only when fundamental rules change
**Why first:** If you don't understand the project's identity and rules, every decision you make will be wrong

**Mandatory sections and exact templates:**

```markdown
# PROJECT CONSTITUTION

## Project Identity
[ONE SENTENCE — engineering identity, not marketing]
Example: "Private Offline Personal AI Computer"
Anti-example: "A cool AI app that does stuff"

## Binding Product Rules
1. [Rule — must be a clear invariant, not a suggestion]
2. [Rule]
... (5-10 rules)

Examples:
1. Local-first does not mean local-only — network features are additive, opt-in
2. Privacy must be visible — every operation shows LOCAL or ONLINE status
3. Agentic behavior is foundational — LLM proposes tools, deterministic code owns permissions
4. Imported/retrieved content is untrusted data — cannot grant permissions or override instructions
5. Never promise unrestricted control of arbitrary mobile apps — use documented platform APIs

## Architectural Invariants
1. UI code depends on contracts (interfaces), never concrete LLM vendors
2. Native AI engines live behind TypeScript interfaces in packages/ai-core
3. Large AI binaries/models are downloaded assets, not committed to Git
4. Domain behavior belongs in domain packs, not scattered conditional prompts
5. Share ingestion normalizes into ContentDocument before AI processing

## Anti-Scope (What This Project Explicitly IS NOT)
- NOT a cloud-only chatbot
- NOT a paste-text demo or summarizer
- NOT a single-industry/product product
- NOT a thin API wrapper

## Technology Choices (with justification)
- Language: TypeScript (strict mode) — type safety at scale
- Monorepo: Turborepo + pnpm — shared types, independent deployables
- Mobile: React Native + Expo — cross-platform from single codebase
- Package manager: pnpm — disk-efficient, strict dependency resolution
```

### 2.3 Document #2: docs/MASTER_PLAN.md — THE BLUEPRINT

**Read:** Second, every session (scan for scope awareness)
**Update:** When phases complete or scope changes

**Mandatory structure:**

```markdown
# MASTER PLAN

## Phase 0: Foundation
### P0-01: Monorepo Setup
- Deliverable: Turborepo with packages/ and apps/
- Acceptance Criteria: `pnpm install && pnpm build` succeeds clean
- Dependencies: None
- Size: S (< 4 hours)

### P0-02: Shared Type System
- Deliverable: @aicp/ui package with ContentDocument, AgentEvent, Tool interfaces
- Acceptance: All packages import shared types without errors
- Dependencies: P0-01
- Size: M (4-12 hours)

## Phase 1: Agent Runtime
...
```

**Rules:**
- Every item has: Deliverable, Acceptance Criteria, Dependencies, Size estimate
- Phases are numbered (P0, P1, P2...) for easy reference
- Dependencies declare what MUST be completed first
- The implementation tracker maps 1:1 to Master Plan items

### 2.4 Document #3: docs/STATUS.md — THE HEARTBEAT

**Read:** Third, every session — THIS is where you learn what to do next
**Update:** END of every session — THIS is your handoff to the next agent
**Why third:** After understanding rules and vision, STATUS tells you exactly where we are

**Exact template (copy this):**

```markdown
# PROJECT STATUS

## Current Snapshot
- Date: YYYY-MM-DD
- Tracker: X/Y (Z%)
- Branch: feat/current-branch-name
- Last commit: <full hash>
- Session: <session description>

## Completed This Session
- [Tracker ID] Description of what was built
- [Tracker ID] Description

## In Progress
- [Tracker ID] Description — partially done, remaining work: [details]

## Blocked
- [Tracker ID] Description — BLOCKED BY: [specific reason, when might unblock]

## Known Issues
- Description (link to GitHub issue if filed)

## Next Session Should
1. [Specific, actionable task — not "continue working"]
2. [Specific, actionable task]
3. [Specific, actionable task]

## Handoff Notes (Tribal Knowledge)
- Things the next agent needs to know that aren't in other documents
- "The ThemeProvider is split: types in packages/ui/src/theme/types.ts (no React),
   runtime in apps/mobile/src/theme/ThemeProvider.tsx (React context)"
```

**STATUS.md rules (DO NOT BREAK ANY OF THESE):**
1. Update at END of every session — never at the beginning
2. Be brutally honest — if something is broken, SAY SO
3. Include exact tracker count (X/Y, Z%)
4. Include branch name and FULL last commit hash
5. "Next Session Should" must be SPECIFIC and ACTIONABLE
6. "Handoff Notes" captures tribal knowledge NOT in other documents

### 2.5 Document #4: docs/EXECUTIVE_DECISIONS.md — THE VAULT

**Read:** Fourth, every session — THIS IS LAW, NOT SUGGESTION
**Update:** Only when the human executive makes a new binding decision
**CRITICAL RULE: DO NOT DOWNGRADE, SILENTLY REMOVE, POSTPONE, OR WEAKEN any decision**

**Template:**

```markdown
# EXECUTIVE DECISIONS

## Decision #N: [Title]
- Date: YYYY-MM-DD
- Status: BINDING (or SUPERSEDED by Decision #X)
- Decision: [Clear, unambiguous statement of what MUST happen]
- Rationale: [Why this decision was made]
- Impact: [What parts of the project this affects]

## Example:
## Decision #1: Offline-First Architecture
- Date: 2026-07-15
- Status: BINDING
- Decision: All core features MUST work without network access.
  Network features are additive and opt-in, not essential.
- Rationale: Privacy + reliability. Users must own their AI.
- Impact: Phases 1-3 local-only. Phase 4+ introduces opt-in network tools.
```

**What to do when a decision blocks you:**

```
CORRECT: "Decision #2 requires capability tiers. I cannot implement the settings
          screen without knowing which tier names to use. Documenting as BLOCKED,
          awaiting executive clarification."

WRONG:    "Capability tiers seem complicated. I'll skip them for now and mark
          the task as DONE."
```

### 2.6 Document #5: docs/ROADMAP.md — THE COMPASS

**Read:** Fifth, every session (scan for priority)
**Update:** When priorities shift or phases are resized

```markdown
# ROADMAP

## Now (Current Phase)
| # | Item | Phase | Size | Status |
|---|------|-------|------|--------|
| 1 | Agent runtime + permission broker | P1 | XL | 🔄 |
| 2 | Device intelligence + tier resolver | P2 | L | ⬜ |

## Next (Following Phase)
| # | Item | Phase | Size |
|---|------|-------|------|
| 3 | Native inference bridge + streaming chat | P3 | XL |

## Later
| # | Item | Phase | Size |
|---|------|-------|------|
| 4 | Platform action adapters | P8 | L |

## Size Legend
S: < 4 hours | M: 4-12 hours | L: 1-3 days | XL: 3-7 days
```

### 2.7 Document #6: docs/BUILD_PLAN.md — THE MANUAL

**Read:** Sixth, reference as needed (deep-read when starting a new phase)
**Update:** When build structure changes

```markdown
# BUILD PLAN

## Phase 1: Agent Runtime

### Package: packages/agent-runtime
- Creates: packages/agent-runtime/
- Depends on: packages/ai-core (interfaces only)
- Exports: AgentRuntime, PermissionBroker, ToolRegistry
- API Contract:
  interface AgentRuntime {
    execute(prompt: string, tools: Tool[]): AsyncIterable<AgentEvent>;
    readonly permissions: PermissionBroker;
  }

### Build Order
1. packages/ai-core (no dependencies, shared interfaces)
2. packages/agent-runtime (depends on ai-core interfaces)
3. apps/mobile (depends on agent-runtime)
```

---

## Chapter 3: The Session Startup Ritual

### 3.0 The Plan → Approve → Autopilot Pipeline (NON-NEGOTIABLE)

**Every session MUST start in PLAN MODE.** This is the canonical workflow. The agent explores, creates a detailed plan, presents it in the canvas widget, and PAUSES for user approval before writing any implementation code.

```
USER STARTS SESSION IN PLAN MODE
    │
    ▼
AGENT EXECUTES THE PREFLIGHT RITUAL (§3.1)
    ├── Read 6 mandatory docs
    ├── Read recent commits and open issues/PRs
    ├── Understand architecture, existing code, current state
    │
    ▼
AGENT CREATES A DETAILED PLAN
    ├── Subatomic tasks broken to smallest verifiable units
    ├── Each task: unique ID, description, status, dependencies, source
    ├── Plan saved to session artifacts and opened in canvas widget
    │
    ▼
AGENT PAUSES — "Waiting for plan approval"
    ├── NO implementation code written
    ├── NO commits made (except docs/tracker scaffolding)
    ├── User reviews each task in the canvas widget
    ├── User approves or rejects with feedback
    │
    ▼
USER APPROVES → SWITCH TO AUTOPILOT
    ├── Agent implements tasks in dependency order
    ├── Commit → Push → Update Tracker after every unit
    └── User sees live progress in the tracker widget
```

**The most common mistake**: Starting a session in autopilot mode. This skips the plan widget entirely — the agent dives into coding without the user seeing the plan. Never do this unless the user explicitly says "skip the plan, just do it."

**The universal startup prompt** (user pastes this):
```
Start in plan mode. Explore the repo, understand the architecture,
read all documentation, then create a detailed plan with subatomic
tasks. Open it in the canvas widget for me to review and approve
before any implementation code is written.
```

### 3.1 The Full Ritual (Copy These Instructions)

```
MANDATORY PREFLIGHT — execute BEFORE writing any code:

1. Read PROJECT_CONSTITUTION.md
2. Read docs/MASTER_PLAN.md
3. Read docs/STATUS.md
4. Read docs/EXECUTIVE_DECISIONS.md
5. Read docs/ROADMAP.md
6. Read docs/BUILD_PLAN.md
7. Read the tracker file from session artifacts
8. Read last 10 commits: git --no-pager log --oneline -10
9. Check current branch: git branch --show-current
10. List open PRs: gh pr list --state open
```

### 3.2 Progressive Understanding

```
Document 1 → Identity + Rules     → "I know what this is and isn't"
Document 2 → Full Scope           → "I know what DONE looks like"
Document 3 → Current State        → "I know WHERE WE ARE"
Document 4 → Constraints          → "I know what I CANNOT CHANGE"
Document 5 → Priority             → "I know WHAT TO DO FIRST"
Document 6 → Build Strategy       → "I know HOW to build it"
```

### 3.3 Context Verification (Self-Test)

After the ritual, you MUST be able to answer:

- [ ] What is this project? (one sentence)
- [ ] Top 3 architectural rules I cannot break?
- [ ] What phase are we on?
- [ ] What was the LAST thing committed?
- [ ] What is the VERY NEXT thing to build?
- [ ] Tracker: how many done / pending / blocked?
- [ ] Which executive decisions are BINDING?
- [ ] What branch am I on?

If you can't answer all 8, **read the documents again.**

### 3.4 Reference vs. Read-Every-Time

| Document | Frequency | Reason |
|----------|-----------|--------|
| PROJECT_CONSTITUTION.md | EVERY session, fully | Rules must never be forgotten |
| MASTER_PLAN.md | EVERY session, scan | Scope awareness prevents drift |
| STATUS.md | EVERY session, carefully | THIS IS YOUR STARTING POINT |
| EXECUTIVE_DECISIONS.md | EVERY session, fully | Decisions are LAW |
| ROADMAP.md | EVERY session, scan | Priority check |
| BUILD_PLAN.md | Reference (deep-read when starting new phase) | Architecture decisions |
| Architecture docs | Reference | When relevant |
| API contracts | Reference | When implementing against interfaces |

---

## Chapter 4: Planning & Tracking — The Atomic Task Methodology

### 4.1 The Core Principle

**Every implementation action gets a unique tracker item.** If it's not in the tracker, it doesn't exist. If it's in the tracker, it WILL be done. This is the single most important technique in the entire playbook.

### 4.2 Tracker Item Anatomy

```markdown
| ID | Description | Phase | Inspiration | Status |
|----|-------------|-------|-------------|--------|
| 8.1.3 | Modal slide_from_bottom 300ms animation | P8 Animations | Copilot Fluent | ✅ DONE |
| 8.4.2 | Dark mode visual verification on iOS device | P8 Dark Mode | Gemini dark mode | ⬜ PENDING |
```

**Field specifications:**

| Field | Required | Format | Example |
|-------|----------|--------|---------|
| ID | YES | `phase.section.item` numeric | 8.1.3, 5.3.2 |
| Description | YES | WHAT to build, imperative mood | "Screen push animation 250ms" NOT "Use Animated.spring()" |
| Phase | YES | Master Plan phase | P8 Animations, P5 Settings |
| Inspiration | YES | Real product + pattern | ChatGPT 2025 bubble, Gemini dark mode |
| Status | YES | Emoji + word | ✅ DONE, 🔄 IN PROGRESS, ⬜ PENDING, ❌ BLOCKED, 🚫 DEFERRED |

### 4.3 Status Lifecycle (State Machine)

```
⬜ PENDING ──→ 🔄 IN PROGRESS ──→ ✅ DONE
                    │                    ↑
                    │ (can't complete)   │ (unblocked)
                    ↓                    │
              ❌ BLOCKED ────────────────┘
                    │
                    │ (won't do now, documented why)
                    ↓
              🚫 DEFERRED
```

**Rules:**
- Only ONE item IN PROGRESS at a time
- BLOCKED requires documented reason (what blocks it, when it might unblock)
- DEFERRED requires documented reason (why not now, when it WILL be done)
- DONE means: coded, typechecked, committed, pushed, tracker updated

### 4.4 The Side Panel Tracker

After creating the tracker file in the session artifacts directory, open it in the Copilot canvas side panel:

```
open_canvas({ canvasId: "editor", instanceId: "tracker", ... })
```

The human sees every item, every status, the completion percentage — updated in real-time as you edit the file. THIS IS CRITICAL. It builds trust and enables monitoring without reading code.

### 4.5 Phase-Based Branching

The tracker should use phase-numbered IDs that map to Git branches:

```
feat/P8-animations          ← Parent phase branch
  ├── 8.1 Screen Transitions
  ├── 8.2 Shimmer Skeletons
  ├── 8.3 Typing Indicator
  └── feat/P8-dark-mode     ← Child task branch (optional)
```

### 4.6 Tracker Maintenance Rules

1. Update the tracker AFTER every commit (not before, not "later")
2. Count total items: always display "X/Y (Z%)" at the top
3. If you discover a new task during implementation, ADD it to the tracker immediately
4. If a task turns out to be impossible, mark it BLOCKED with a reason — never silently delete it
5. The tracker lives in the session artifacts directory: `C:/Users/<user>/.copilot/session-state/<uuid>/files/`

---

## Chapter 5: Architecture-First Development

### 5.1 The Rule — Ask These Three Questions Before Every Implementation

Before writing ANY code, answer:

1. **Where do the TYPES live?** (shared package? local to the app?)
2. **Where does the RUNTIME live?** (which app? which package?)
3. **What are the DEPENDENCIES?** (what must exist before this can work?)

### 5.2 Real Example: The ThemeProvider Split

**Problem:** ThemeProvider needs React Context (runtime), but `packages/ui` is a shared types package with NO React dependency.

**Wrong approach:** Add React as a dependency to `packages/ui`.
**Right approach:** Split the concern:

```
packages/ui/src/theme/types.ts       ← TypeScript types ONLY (ThemeMode, ThemeColors)
apps/mobile/src/theme/ThemeProvider.tsx  ← React Context runtime (useTheme, ThemeProvider)
```

**Lesson:** Types live in shared packages. Runtime lives in apps. NEVER add framework dependencies to a types-only package.

### 5.3 The Architecture Decision Tree

```
Is this a type/interface or runtime code?
  ├─ TYPE → packages/ui (shared, zero framework dependencies)
  ├─ REACT RUNTIME → apps/mobile or apps/desktop
  ├─ SHARED LOGIC (no React) → packages/ai-core or packages/shared
  └─ AI/ML native code → packages/ai-core (behind TypeScript interfaces)
```

### 5.4 Monorepo Package Boundaries

| Package | Can Import From | Cannot Import From |
|---------|----------------|-------------------|
| `packages/ui` | Nothing (leaf node — types only) | Anything with React/RN |
| `packages/ai-core` | `packages/ui` (types) | `apps/*` |
| `apps/mobile` | `packages/ui`, `packages/ai-core` | `apps/desktop` |
| `apps/desktop` | `packages/ui`, `packages/ai-core` | `apps/mobile` |

### 5.5 Contract-First Development

Before building a new package, define its public API contract:

```typescript
// packages/ai-core/src/agent.ts — THE CONTRACT
export interface AgentRuntime {
  execute(prompt: string, tools: Tool[]): AsyncIterable<AgentEvent>;
  readonly permissions: PermissionBroker;
}

export interface AgentEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'error' | 'done';
  data: unknown;
}
```

The contract is stable — implementations behind it can change freely.

---

## Chapter 6: Design-by-Reference — Never Design From Scratch

### 6.1 The Technique

For every UI component, the spec MUST reference which real product's pattern to follow. This eliminates "design from scratch" paralysis and guarantees professional results.

### 6.2 The Assignment Table (Copy This Pattern)

| Design Layer | Inspiration Product | Specific Pattern |
|-------------|-------------------|------------------|
| Layout & Navigation | ChatGPT 2025 | Tab-based, clean hierarchy, bottom tabs on mobile |
| Color System (Light) | ChatGPT | #ffffff bg, #f7f7f7 surface, #5b8cff accent |
| Color System (Dark) | Gemini | #0d1016 bg, #171a21 surface, #7ba4ff accent |
| Typography | ChatGPT | Inter, 16px body, 20px title, specific weights |
| Motion & Animation | Microsoft Copilot Fluent | 250ms ease-out screens, 300ms modals, reduced-motion support |
| Iconography | Phosphor Icons | Regular weight, 20px default, 16px small |

### 6.3 Vague vs. Exact Specs

```
BAD:  "A rounded chat bubble with nice padding"
GOOD: "ChatGPT 2025 bubble: 18px border-radius, 16px padding horizontal, 12px vertical,
       max-width 70%, user: #5b8cff bg right-aligned, assistant: #f0f0f0 bg left-aligned,
       250ms appear animation ease-out with 8px vertical slide"

BAD:  "Dark mode with dark background"
GOOD: "Gemini dark mode: #0d1016 primary background, #171a21 elevated surface,
       #f0f0f0 primary text (87% contrast), #7ba4ff accent, #2a2d35 input field bg,
       80% minimum contrast ratio on all text"
```

### 6.4 Component Anatomy Breakdown

Every major component must be spec'd with exact measurements:

```
Component: ChatBubble
  Container: max-width 70%, border-radius 18px, padding 16px 12px
  User variant: background #5b8cff, align-self flex-end, border-bottom-right-radius 4px
  Assistant variant: background #f0f0f0 (light) / #171a21 (dark), align-self flex-start
  Animation: 250ms ease-out, opacity 0→1, translateY 8px→0
  States: default, loading (shimmer), error (red border)

Component: SuggestionChip
  Container: height 36px, padding 8px 16px, border-radius 18px (pill)
  Background: #f0f0f0 (light) / #2a2d35 (dark)
  Press state: background #5b8cff15, border #5b8cff
  Text: 14px, #333 (light) / #ddd (dark)
```

### 6.5 The Three-Inspiration Rule

Always study THREE products, never one. One product → imitation. Three products → synthesis.

For AI chat applications: ChatGPT (layout + bubbles), Gemini (dark mode + color), Copilot (animations + glassmorphism).
For productivity: Notion (hierarchy), Linear (minimalism), Superhuman (keyboard shortcuts).
For developer tools: Stripe (docs design), Vercel (deploy UX), GitHub (code review patterns).

---

## Chapter 7: The Commit-Push-Tracker Cycle

### 7.1 The Atomic Rhythm

This is the heartbeat of productive Copilot work:

```
1. Complete ONE logical unit of work (component, screen, fix)
2. Typecheck: pnpm --filter <package> typecheck
3. Git add <specific files>           ← NEVER git add -A blindly
4. Git commit with descriptive message
5. Git push                           ← IMMEDIATELY, never batch
6. Update tracker: mark items DONE, update percentage
7. Repeat
```

### 7.2 Commit Message Format

```
feat(scope): what changed — brief summary under 72 characters

Detailed explanation of WHAT and WHY:
- Bullet points for each change
- Reference tracker IDs (e.g., 8.3.1, 8.3.2)
- Note any architectural decisions made

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```

### 7.3 Why Push After EVERY Commit (Never Batch)

1. **Crash protection:** If the session crashes, nothing is lost
2. **Continuity:** Another agent picks up from the last push
3. **Visibility:** The human sees progress on GitHub in real-time
4. **Recovery:** Git reflog + remote = impossible to lose work

### 7.4 What Counts as a "Logical Unit"

| This is a logical unit | This is NOT a logical unit |
|------------------------|---------------------------|
| One complete component + its types | Half a component |
| One screen wired into navigation | Unrelated typo fixes bundled with a feature |
| One bug fix with root cause documented | Three unrelated fixes in one commit |
| Dark mode wiring for one screen | "WIP — saving progress" |

### 7.5 Tracker Update Protocol

After every push, update the tracker IMMEDIATELY:

```markdown
| ID | Description | Phase | Inspiration | Status |
|----|-------------|-------|-------------|--------|
| 8.1.1 | Screen push animation 250ms | P8 Animations | Copilot Fluent | ✅ DONE |
| 8.1.2 | Screen pop animation 250ms | P8 Animations | Copilot Fluent | ✅ DONE |
| 8.1.3 | Modal slide_from_bottom 300ms | P8 Animations | Copilot Fluent | 🔄 IN PROGRESS |

Total: 247/255 (96.9%)
```

---

## Chapter 8: Tool Usage & Power Patterns

### 8.1 Available Tools in the Copilot Environment

| Tool | Primary Use | Pro Tip |
|------|------------|---------|
| `view` | Reading files | Parallelize — read 3+ files in ONE call |
| `edit` | String replacements | Batch multiple edits to same file in ONE call |
| `create` | New files ONLY | Never overwrite existing files with create |
| `powershell` | Commands, builds, tests, git | Sync for short, async for long-running |
| `grep` | Code search | Use `-n` + `output_mode: "content"` for line numbers |
| `glob` | File search by pattern | Faster than grep for finding files by name |
| `task` | Delegating to sub-agents | Only for genuinely complex multi-step work |
| `sql` | Session database | Use for structured state, todos, batch items |
| `web_search` | Current information | Always cite sources |
| `web_fetch` | Reading web pages | Use for documentation, design references |

### 8.2 Parallelism — The #1 Speed Multiplier

ALWAYS batch independent operations:

```
// GOOD — 3 reads in ONE response, parallel execution
view(path="file1.tsx")
view(path="file2.tsx")
view(path="file3.tsx")

// BAD — sequential reads, wasted round-trips
view(path="file1.tsx")  ← wait
view(path="file2.tsx")  ← wait
view(path="file3.tsx")  ← wait
```

Same for edits: multiple `edit` calls to the SAME file in ONE response are applied sequentially by the tool.

### 8.3 PowerShell Patterns (Windows-Specific)

```powershell
# CRITICAL: Paths with parentheses MUST be quoted
git add "apps/mobile/src/app/(tabs)/settings.tsx"    # CORRECT
git add apps/mobile/src/app/(tabs)/settings.tsx      # WRONG — breaks

# git push exit code 1 is NORMAL on Windows
# Git writes progress to stderr, PowerShell treats as error
git push 2>&1
# Verify: if output shows "main -> main", push SUCCEEDED

# Typecheck a specific package
pnpm --filter @aicp/mobile typecheck

# Sequential dependent commands (no && in Windows PowerShell)
pnpm --filter @aicp/mobile typecheck
if ($?) { echo "Typecheck passed" } else { echo "FAILED" }
```

### 8.4 Common Tool Mistakes

| Mistake | Why It Happens | Fix |
|---------|---------------|-----|
| `git add -A` | Laziness | Always add specific files |
| Sequential reads | Forgetting parallelism | Batch all reads in one response |
| Pushing batched commits | "I'll push later" | Push after EVERY commit |
| Using `edit` when file doesn't exist yet | Wrong tool | Use `create` for new files |
| Delegating simple searches to sub-agents | Over-delegation | Use `grep`/`glob` directly |

---

## Chapter 9: Error Recovery & Debugging

### 9.1 The 6-Step Recovery Protocol

When something breaks:

1. **DON'T PANIC.** Read the FULL error message — the answer is usually in it
2. **ISOLATE:** Which file? Which line? What dependency is missing?
3. **UNDERSTAND:** Why did this break? (strict mode? missing dep? wrong type?)
4. **FIX MINIMALLY:** The smallest change that resolves the root cause
5. **VERIFY:** Typecheck/build/tests pass
6. **COMMIT:** With explanation of WHAT broke and WHY

### 9.2 The Top 10 Pitfalls (From Real Experience)

| # | Pitfall | Symptom | Fix |
|---|---------|---------|-----|
| 1 | React Native accessibilityRole | TypeScript error on `role="status"` | RN only allows: "none", "button", "header", "link", "alert", "progressbar", "text", "list" |
| 2 | Paths with parentheses in PowerShell | Command fails silently | Wrap path in quotes: `"src/(tabs)/file.tsx"` |
| 3 | git push exit code 1 | PowerShell shows error | NORMAL on Windows — verify "main -> main" in output |
| 4 | ColorSchemeName null | Type error on `Appearance.getColorScheme()` | Always `?? 'light'` fallback |
| 5 | Missing React dependency in types package | Import errors | Types go in shared packages, runtime goes in apps |
| 6 | Animated.loop memory leak | Animation keeps running | Clean up in useEffect return: `animation.stop()` |
| 7 | Touch target too small | Accessibility violation | 40px MINIMUM for any interactive element |
| 8 | Forgetting to update tracker | Stale percentages | Update tracker AFTER EVERY COMMIT |
| 9 | Accumulating local commits | git log shows unpushed | Push after EVERY commit |
| 10 | Skipping the 6-document ritual | Working on wrong phase | Read ALL 6 docs before ANY code |

### 9.3 TypeScript Strict Mode Survival

```typescript
// Null safety
const colorScheme = Appearance.getColorScheme() ?? 'light';  // NOT: getColorScheme() alone

// Exhaustive checks
type Status = 'pending' | 'active' | 'done';
function handleStatus(s: Status) {
  switch (s) {
    case 'pending': return '⬜';
    case 'active': return '🔄';
    case 'done': return '✅';
    default: {
      const _exhaustive: never = s;  // TypeScript will error if we missed a case
      return _exhaustive;
    }
  }
}
```

### 9.4 When You're Truly Stuck

1. Search the codebase for similar patterns: `grep "pattern" --glob="*.tsx"`
2. Check if any other package has the same dependency pattern
3. Read the error file at the line indicated — the real error is often above the line number
4. If genuinely blocked, document it in STATUS.md and move to the next task
5. NEVER silently skip a task because it's hard

---

## Chapter 10: The Handoff Protocol

### 10.1 The "Bus Factor" Rule

If you disappeared RIGHT NOW, could another agent:
- Read STATUS.md and know exactly where to start?
- Read the tracker and know what's done vs. pending?
- Read the git log and understand what happened?

If NO, you haven't documented enough. Fix it before ending your session.

### 10.2 End-of-Session Checklist

- [ ] All commits pushed to GitHub
- [ ] STATUS.md updated with: current tracker count, completed items, pending items, known issues, next steps
- [ ] Tracker updated with all items marked honestly
- [ ] Handoff Notes section filled with tribal knowledge
- [ ] Any new architectural decisions documented
- [ ] Branch name and last commit hash recorded in STATUS.md
- [ ] No uncommitted local changes: `git status --porcelain` is empty

### 10.3 What the Handoff Notes Must Include

The "Handoff Notes" section of STATUS.md captures knowledge that ISN'T in any other document:

```markdown
## Handoff Notes
- ThemeProvider split: types in packages/ui/src/theme/types.ts (NO React deps),
  runtime in apps/mobile/src/theme/ThemeProvider.tsx
- PowerShell requires quoting paths with parentheses: git add "src/(tabs)/file.tsx"
- package/ui is types-only — never add React/RN as dependencies
- Typecheck command: pnpm --filter @aicp/mobile typecheck
- git push returns exit code 1 on Windows due to stderr progress output — verify "main -> main"
```

---

## Chapter 11: Quality Standards & Checklists

### 11.1 The Component Quality Checklist

Every component MUST satisfy ALL of these before being marked DONE:

- [ ] Props are typed with a TypeScript interface
- [ ] JSDoc comment explains what it is and which spec/inspiration it follows
- [ ] `accessibilityLabel` set on interactive elements
- [ ] `accessibilityRole` set correctly (button, header, link, text, none)
- [ ] Touch targets are 40px minimum (accessibility requirement)
- [ ] Works in both light AND dark mode (or documented why not)
- [ ] Animation respects `prefers-reduced-motion` where applicable
- [ ] Error/empty/loading states are handled
- [ ] No hardcoded strings (use constants or theme values)
- [ ] No console.log left in production code

### 11.2 The Commit Quality Checklist

Every commit MUST:

- [ ] Descriptive subject line: `feat(scope): what changed`
- [ ] Body explains WHY, not just WHAT
- [ ] References tracker IDs (e.g., "8.3.1, 8.3.2")
- [ ] `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>` trailer
- [ ] All modified files are intentionally modified (no accidental changes)
- [ ] Typecheck passes on the affected package
- [ ] No unrelated changes bundled in

### 11.3 The Session Quality Checklist

Every session MUST:

- [ ] Read all 6 mandatory documents before writing code
- [ ] Updated tracker after each commit
- [ ] Updated STATUS.md at session end
- [ ] All work pushed to GitHub
- [ ] Clear handoff for next agent
- [ ] No `git status --porcelain` output (nothing uncommitted)

### 11.4 The Hard-Line Quality Rules

These are NON-NEGOTIABLE:

1. **Never merge with typecheck failures.** If it doesn't compile, it doesn't ship.
2. **Never mark a task DONE without committing and pushing.** DONE = coded + typed + committed + pushed + tracked.
3. **Never leave a session without updating STATUS.md.** That's abandoning the next agent.
4. **Never downgrade an EXECUTIVE_DECISIONS item.** Document the blocker, don't silently remove it.
5. **Never design from scratch.** Every component cites its inspiration.

---

## Chapter 12: Prompt Templates — Copy-Paste Battle-Tested

### 12.1 Prompt #1: Starting a NEW Project (Zero Files)

```
You are taking on a brand new project. There are no existing files.
Your job is to set up the project structure and planning artifacts
BEFORE writing any implementation code.

PHASE 0 — Project Setup (commit after each step):

Step 1: Create PROJECT_CONSTITUTION.md
Contains: one-sentence project identity, 5-10 binding product rules,
architectural invariants, anti-scope declaration, technology choices.

Step 2: Create docs/MASTER_PLAN.md
Contains: complete feature list organized by numbered phases,
every item has Deliverable, Acceptance Criteria, Dependencies, Size.

Step 3: Create docs/ROADMAP.md
Contains: priority order (Now/Next/Later), sizing estimates,
dependencies between phases.

Step 4: Create docs/BUILD_PLAN.md
Contains: how each phase will be built, package creation order,
API contracts between modules.

Step 5: Create the implementation tracker
EVERY single task with: ID, Description, Phase, Inspiration, Status.
Save to session artifacts directory. Open in canvas side panel.

Step 6: Create docs/EXECUTIVE_DECISIONS.md (initially empty)
Document any decisions the executive has already made.

PHASE 1 — Design System (for UI projects):

Step 7: Pick 3 industry-leading products in this category.
Assign ownership: Layout from A, Colors from B, Animations from C.

Step 8: Write exact measurements for every component.
"ChatGPT 2025 bubble: 18px radius, 16px padding, 250ms ease-out"
NOT "A nice chat bubble"

CRITICAL RULES:
- Commit after EVERY document is written
- Push after EVERY commit
- NEVER implement until all planning docs are complete
- NEVER design from scratch — always reference real products
- After setup, follow the standard commit-push-tracker cycle
```

### 12.2 Prompt #2: Taking Over an EXISTING Project

```
You are taking over an existing project. Your FIRST actions:

1. Read PROJECT_CONSTITUTION.md — what are the rules?
2. Read docs/MASTER_PLAN.md — what's the full scope?
3. Read docs/STATUS.md — where did the last agent leave off?
4. Read docs/EXECUTIVE_DECISIONS.md — what CANNOT be changed?
5. Read docs/ROADMAP.md — what's the priority?
6. Read docs/BUILD_PLAN.md — how do we build?

After reading all 6:
- Read the tracker file to get exact done/pending/blocked counts
- Read the last 10 commits: git --no-pager log --oneline -10
- List open PRs: gh pr list --state open
- Check current branch: git branch --show-current

ONLY THEN take action:
- Continue from where STATUS.md says
- Follow the commit-push-tracker cycle
- Update STATUS.md at session end
- NEVER change architecture without understanding it
- NEVER downgrade capabilities from EXECUTIVE_DECISIONS.md

If STATUS.md is missing or stale:
- Create/update it immediately
- Audit: what exists vs what the tracker says?
- Report discrepancies to the human
```

### 12.3 Prompt #3: UI/UX Design

```
You are designing the UI/UX for [PROJECT].

Step 1: Pick 3 inspirations — top products in this category.
Step 2: Assign ownership — Layout from A, Colors from B, Animations from C.
Step 3: Write EXACT measurements — never vague.
Step 4: Create component anatomy for every major component:
  - Container, Header, Content, Actions, States, Dark mode, Accessibility
Step 5: Break everything into implementation tasks.
Step 6: Open tracker in canvas side panel.

CRITICAL RULES:
- NEVER design from scratch. Always reference real products.
- NEVER vague measurements. Always exact px/ms/hex values.
- ALWAYS design dark mode simultaneously with light mode.
- ALWAYS include accessibility (labels, roles, 40px touch targets).
- EVERY color gets both light and dark values.
```

---

## Chapter 13: Scaling Across Multiple Agents

### 13.1 When to Use Multiple Agents

Single agent: One phase at a time, linear execution. Works for solo projects and most work.
Multiple agents: Parallel phases with no dependencies. Phase 3 (mobile UI) and Phase 4 (agent runtime) can run simultaneously if they only share types.

### 13.2 The Dependency Branching Model

```
main
├── feat/P3-mobile-ui (Agent A: screens, components, navigation)
│   ├── feat/P3-settings (child: settings screen)
│   └── feat/P3-chat (child: chat interface)
└── feat/P4-agent-runtime (Agent B: permission broker, tools, execution)
    ├── feat/P4-permissions (child: permission system)
    └── feat/P4-tools (child: tool registry)
```

Both agents work independently. They merge into main when their phase is complete. They coordinate through shared types in `packages/ui`.

### 13.3 Multi-Agent Rules

1. **Never work on the same file** — this creates merge conflicts
2. **Coordinate through interfaces** — both agents agree on the contract in `packages/ui`
3. **Status updates are per-agent** — each agent maintains its own section in STATUS.md
4. **Tracker is shared** — both agents update the same tracker, but only their own items
5. **Merge parent into main first, then child branches**

### 13.4 Cross-Session Messaging

The Copilot environment supports cross-session messaging. Agents can send messages to each other:

```
Agent A: "I've updated the AgentEvent interface in packages/ui. Added 'progress' type.
         Your tools should handle this new event type."
Agent B: "Received. Updating ToolRegistry to emit progress events. ETA 2 commits."
```

---

## Chapter 14: The Golden Rules — One-Page Reference Card

### THE 14 GOLDEN RULES

1. **READ before you WRITE** — the 6-document ritual, every session, no exceptions
2. **PLAN before you CODE** — detailed tracker with every item, visible in side panel
3. **COMMIT after every unit** — one logical change per commit, never accumulate
4. **PUSH after every commit** — nothing stays local, ever
5. **UPDATE tracker immediately** — after every push, mark items DONE
6. **DOCUMENT decisions** — EXECUTIVE_DECISIONS.md is law, never downgrade
7. **REFERENCE real products** — never design from scratch, always cite inspiration
8. **SPLIT types from runtime** — types in shared packages, runtime in apps
9. **HANDOFF completely** — STATUS.md updated, everything pushed, no tribal knowledge lost
10. **VERIFY before claiming done** — typecheck passes, build succeeds, tracker updated
11. **BE HONEST about blockers** — document what's broken, don't silently skip
12. **NEVER git add -A** — be intentional about every file staged
13. **40PX touch targets** — minimum for every interactive element
14. **LEAVE IT BETTER** — every session should leave the project more organized than found

---

# VOLUME II: APPENDICES

---

## Appendix A: Real Examples from ai-content-processor

### A.1 Tracker Evolution

```
Session Start:  193/259 (74.5%) — Phase 7 mobile screens not started
After Session:  246/255 (96.5%) — All code complete, 9 device-dependent items remain
```

### A.2 Sample Commit (Annotated)

```
commit 1ed62c2
feat(mobile): wire dark mode into Chat and Files tabs

Dark mode wiring:
- Chat tab (index.tsx): dynamic styles via useTheme() for bg, textPrimary,
  textSecondary, border, accent
- Files tab: bg + card colors from theme context
- Both tabs now respond to Appearance changes and manual toggle
- [8.4.1, 8.4.4]

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```

### A.3 Architecture Decision (Documented)

```
DECISION: ThemeProvider Split
Problem: ThemeProvider needs React context, but packages/ui is types-only
Options:
  A) Add React as dependency to packages/ui — REJECTED (violates architecture)
  B) Duplicate types in each app — REJECTED (DRY violation)
  C) Split: types in packages/ui, runtime in apps/mobile — ACCEPTED
Impact: Any shared type lives in packages/ui. Any React runtime lives in apps/.
```

---

## Appendix B: Tool Cheat Sheets

### B.1 Git — The Only Commands You Need

```bash
# Status and context
git status --porcelain                    # Am I clean?
git --no-pager log --oneline -10         # What happened recently?
git branch --show-current                 # What branch am I on?

# Staging and committing
git add "path/to/file.tsx"               # Stage ONE specific file
git add "path/to/file1.tsx" "path/to/file2.tsx"  # Stage multiple specific files
git commit -m "feat(scope): subject

Body with bullet points.
Refs: 8.1.3, 8.2.1

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"

# NEVER USE
git add -A                               # DANGEROUS — stages everything
git add .                                # DANGEROUS — stages everything in cwd
git commit -m "fix"                      # USELESS — no context for future readers
```

### B.2 TypeScript — Typecheck Commands

```bash
# Per-package typecheck
pnpm --filter @aicp/mobile typecheck
pnpm --filter @aicp/ui typecheck

# Full project typecheck (slow, use sparingly)
pnpm typecheck
```

### B.3 React Native — Common Patterns

```tsx
// Theme-aware component
const theme = useTheme();
const styles = {
  container: {
    backgroundColor: theme.colors.bg,
    padding: 16,
  } as React.CSSProperties,
};

// Accessible button (40px minimum)
<TouchableOpacity
  accessibilityRole="button"
  accessibilityLabel="Send message"
  style={{ minHeight: 40, minWidth: 40, justifyContent: 'center' }}
  onPress={handlePress}
>
  <Icon size={20} />
</TouchableOpacity>
```

---

## Appendix C: Troubleshooting Guide

### C.1 Build & Type Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot find module '@aicp/ui'` | Package not built | `pnpm --filter @aicp/ui build` |
| `Type 'ColorSchemeName \| null' not assignable` | Missing null check | `Appearance.getColorScheme() ?? 'light'` |
| `Property 'jsx' does not exist` | React dependency missing | Check if you're in a types-only package |
| `Cannot use JSX without '--jsx' flag` | tsconfig missing jsx setting | Add `"jsx": "react-jsx"` to tsconfig |

### C.2 PowerShell-Specific

| Error | Cause | Fix |
|-------|-------|-----|
| `git push` exit code 1 | stderr progress output | Normal on Windows — verify "main -> main" |
| Path parsing error with `(tabs)` | PowerShell treats parens as expressions | Quote paths: `"src/(tabs)/file.tsx"` |
| `&&` operator fails | Not available in Windows PowerShell | Use `; if ($?) { ... }` pattern |

### C.3 Runtime Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `accessibilityRole "status"` on View | Not valid for RN View | Use `"none"` or `"text"` |
| Theme not updating | Missing Appearance listener | `Appearance.addChangeListener()` in useEffect |
| Animation loop memory leak | Animation never stopped | `animation.stop()` in useEffect cleanup |

---

> **END OF PLAYBOOK v2.0**
>
> This methodology was extracted from the successful execution of the ai-content-processor project and refined into a replicable system. It is designed to work with any Copilot agent, any project type, any technology stack.
>
> For licensing, customization, or training: contact the author.