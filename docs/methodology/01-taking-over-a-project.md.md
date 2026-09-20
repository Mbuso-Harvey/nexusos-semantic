# 01 — Taking Over an Existing Project

> **Use this when:** You're joining a project that already has code, documentation,
> and an established structure. Your job is to understand, assess, and continue
> without breaking anything.

---

## Standard Operating Procedure: Session Startup (NON-NEGOTIABLE)

**Every session MUST start in PLAN MODE.** This is the canonical workflow. No exceptions.

### The Plan → Approve → Autopilot Pipeline

```
USER STARTS SESSION IN PLAN MODE
    │
    ▼
AGENT EXPLORES THE REPO
    ├── Read 6 mandatory docs (Constitution → Master Plan → Status → Exec Decisions → Build Plan → Roadmap)
    ├── Read recent commits and open issues/PRs
    ├── Understand architecture, existing code, and current state
    │
    ▼
AGENT CREATES A DETAILED PLAN
    ├── Subatomic tasks broken down to smallest verifiable units
    ├── Each task: unique ID, description, status, dependencies, inspiration source
    ├── Plan appears in the canvas widget (visible to user in sidebar)
    │
    ▼
AGENT PAUSES — "Waiting for plan approval"
    ├── DO NOT write any implementation code
    ├── DO NOT make any commits (except documentation/tracker)
    ├── User reviews each task, approves or rejects with feedback
    │
    ▼
USER APPROVES → SWITCH TO AUTOPILOT
    ├── Agent begins implementing tasks in dependency order
    ├── Commit → Push → Update Tracker after every logical unit
    └── User sees live progress in tracker widget
```

### Session Mode Decision Matrix

| When... | Start In | Then... |
|---|---|---|
| Joining an existing project | **Plan mode** | Explore → plan → get approval → autopilot |
| Starting a new project | **Plan mode** | Create 6 docs → plan phases → get approval → autopilot |
| Fixing a specific bug | **Plan mode** | Explore the bug → plan the fix → get approval → autopilot |
| Adding a specific feature | **Plan mode** | Explore the codebase → plan the feature → get approval → autopilot |
| User explicitly says "just do it" | **Autopilot** (rare) | Skip plan, but still read docs first |
| User wants to drive step-by-step | **Interactive** | Agent proposes, user approves each step |

### The Plan Widget (What the User Sees)

When a session is in plan mode, the plan appears as a **canvas widget** in the sidebar. It contains:
- All subatomic tasks with status indicators (⬜/🟦/✅/❌)
- The user can click "Approve" to proceed or "Reject" with feedback
- After approval, the widget continues updating as tasks are completed

### Creating the Plan Prompt (For Users)

When you start a session, tell the agent:
```
"Start in plan mode. Explore the repo, understand the architecture,
read all existing documentation, then create a detailed plan with
subatomic tasks. Open it in the canvas widget for me to review and
approve before any implementation."
```

### The Agent's Plan-Mode Responsibilities

1. **Explore thoroughly** — read every relevant file, understand dependencies
2. **Break everything into subatomic tasks** — one verifiable action per task
3. **Map tasks to existing issues/PRs** — never duplicate work
4. **Cite sources** — every UI task references a real product (ChatGPT/Gemini/Copilot)
5. **Show dependencies** — what must be done first?
6. **Open in canvas** — the plan must be visible to the user
7. **PAUSE** — wait for approval, do not start coding

### ⚠️ The Most Common Mistake

**Starting in autopilot mode.** This skips the plan widget entirely. The agent dives straight into coding without the user seeing what's planned. Trust evaporates. The user can't catch hallucinations before code is written.

**ALWAYS default to plan mode unless the user explicitly requests otherwise.**

---

## The Onboarding Sequence (30-60 minutes)

### Step 1: Environment Verification

Before reading anything, verify the project actually builds:

```bash
pnpm install          # or npm install / yarn
pnpm build            # or the project's build command
pnpm test             # if tests exist — establish baseline
```

If the build fails, document the failure before proceeding. You can't assess
a project you can't compile.

### Step 2: Mandatory Reading (In This Exact Order)

**When**: Read ALL of these ONCE at the start of your session. You do NOT re-read
them before every commit. You keep the Constitution and Executive Decisions in
working memory as binding constraints. You reference the others when ambiguity arises.

| # | File | Why | Time | Re-read? |
|---|---|---|---|---|
| 1 | `PROJECT_CONSTITUTION.md` | The law. Violate it and you'll be corrected. | 5 min | **Once per session** — keep in working memory |
| 2 | `docs/MASTER_PLAN.md` | What are we building? What phases exist? | 10 min | **Once per session** — reference as needed |
| 3 | `docs/STATUS.md` | Where are we right now? What's blocked? | 5 min | **Once per session** — you will UPDATE this at end |
| 4 | `docs/EXECUTIVE_DECISIONS.md` | What decisions are locked? NEVER override. | 10 min | **Once per session** — keep in working memory |
| 5 | `docs/BUILD_PLAN.md` | What depends on what? Build order. | 5 min | **Once** — rarely changes |
| 6 | `docs/ROADMAP.md` | Timeline and priorities. | 5 min | **Once** — rarely changes |

**Critical rule**: Executive decisions in `EXECUTIVE_DECISIONS.md` are BINDING.
You may not downgrade, remove, or "simplify" them because implementation is hard.
If you're blocked by one, document the blocker and request a decision — don't
silently change the requirement.

### Step 3: Tracker Reconstitution

Create an implementation tracker. This is your dashboard for the entire engagement.

**Where to save it**: The session artifacts directory at `C:/Users/<user>/.copilot/session-state/<session-uuid>/files/`. This directory persists across turns within the session.

**Format**:
```markdown
| ID | Task | Plan Reference | Status | Inspiration Source |
|---|---|---|---|---|
```

**Status values**:
- `⬜ PENDING` — not yet started
- `🚧 IN PROGRESS` — actively working
- `✅ DONE` — completed and verified
- `⏸️ BLOCKED` — cannot proceed (include reason)
- `⚠️ DEFERRED` — intentionally postponed (include reason)

**How to populate it**:
1. Read the existing tracker if one exists (in session artifacts or repo)
2. Cross-reference with `STATUS.md` and `MASTER_PLAN.md`
3. Every item must be atomic — one verifiable thing
4. Every UI item MUST cite a design inspiration source
5. Save to `files/ui-implementation-tracker.md` in the session artifacts directory
6. Open in the canvas side panel using the absolute path

**Example items from a real project**:
```markdown
| P9.6.2.3 | Typing indicator: 3 bouncing dots + "Thinking…" label | Plan 162 | ✅ DONE | ChatGPT |
| P9.6.2.14 | Voice recording waveform visualization | Plan 167 | ⬜ PENDING | ChatGPT |
| P9.8.5.1 | Test mobile UI on iOS simulator | — | ⏸️ BLOCKED: no macOS | — |
| P9.6.3.5 | Magic numbers audit — replace all hardcoded px with tokens | Plan 26 | ⚠️ DEFERRED: 4px scale already consistent; mechanical migration | Gemini |
```

### Step 4: SQL Task Tracking

Set up dependency-tracked todos in the session database.

**Naming convention**: Use gerund-form kebab-case IDs (e.g., `creating-shimmer`, `adding-a11y-labels`, `fixing-dark-mode-fouc`). Write titles in gerund form ("Creating Shimmer component").

```sql
-- Create tasks with gerund-form IDs
INSERT INTO todos (id, title, description, status)
VALUES ('creating-shimmer', 'Creating Shimmer component', 'Build 5 shimmer variants + loading states in packages/ui', 'pending');

-- Track that wiring depends on the shimmer component being done
INSERT INTO todo_deps (todo_id, depends_on)
VALUES ('adding-shimmer-to-views', 'creating-shimmer');

-- Find tasks ready to work on (no pending dependencies)
SELECT t.* FROM todos t
WHERE t.status = 'pending'
AND NOT EXISTS (
    SELECT 1 FROM todo_deps td
    JOIN todos dep ON td.depends_on = dep.id
    WHERE td.todo_id = t.id AND dep.status != 'done'
);
```

### Step 5: First Commit

Your first commit should be one of:
- Documentation update (if you found gaps)
- Build fix (if the project didn't compile)
- Tracker file (if none existed)

**Never** start with a feature change. Your first commit proves you understand
the project's toolchain and commit conventions.

**Example first commit**:
```
docs: add agent methodology to project

Documents the working methodology — reading order, commit discipline,
tracker format, and design-by-reference rules.

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```

---

## The Complete Session Workflow

This is the exact sequence to follow for every change you make. It is designed
so that at ANY point the user (or another agent) can see exactly what was done,
what's in progress, and what's blocked.

### The Development Cycle (Execute for EVERY Change)

```
1. SELECT — Query SQL for ready todos, pick next item from tracker
2. MARK IN PROGRESS — Update tracker item to 🚧 IN PROGRESS, SQL todo to in_progress
3. READ CONTEXT — Reference relevant MASTER_PLAN section, check EXECUTIVE_DECISIONS constraints
4. IMPLEMENT — Write code using edit tool. For UI: verify icon exists, use var() with fallback
5. VERIFY — pnpm tsc (0 errors) → pnpm build (0 warnings) → fix issues → repeat
6. COMMIT — git add -A; git commit -m "type(scope): description" + Co-authored-by trailer
7. PUSH — git push (NEVER accumulate unpushed commits)
8. UPDATE TRACKER — Mark item ✅ DONE in tracker file, save it
9. UPDATE SQL — Mark todo as done
10. UPDATE STATUS — Only at END of session or when phase/blocker changes
11. NEXT TASK — Return to step 1
```

### Exact Document Update Frequency

| Document | When to Update | How Often |
|---|---|---|
| **Tracker** (`files/ui-implementation-tracker.md`) | After EVERY commit | Every commit |
| **SQL todos** | After EVERY commit | Every commit |
| **STATUS.md** | End of session, phase change, new blocker | 1-3 times per session |
| **EXECUTIVE_DECISIONS.md** | When new binding decision is made | Rarely |
| **MASTER_PLAN.md** | When scope changes | Rarely |
| **ROADMAP.md** | When timelines shift | Rarely |
| **PROJECT_CONSTITUTION.md** | When rules change | Almost never |
| **BUILD_PLAN.md** | When build structure changes | Rarely |

### Example: A Complete Cycle

Here's what one cycle looked like during the desktop app redesign:

```
1. SELECT: Picked P9.8.1.3 "Sidebar collapse fade transitions" — next pending item
2. MARK: Updated tracker line to 🚧 IN PROGRESS
3. READ: Checked Plan §Transitions: 200ms ease-out, Copilot Fluent pattern
4. IMPLEMENT: Added CSS transition to sidebar collapse classes
5. VERIFY: pnpm tsc → 0 errors, pnpm build → 0 warnings
6. COMMIT: "style(desktop): add sidebar collapse fade transitions (Copilot pattern)"
7. PUSH: git push → success
8. UPDATE TRACKER: Changed P9.8.1.3 to ✅ DONE | Copilot
9. UPDATE SQL: UPDATE todos SET status = 'done' WHERE id = 'adding-sidebar-transitions'
10. NEXT: Picked P9.8.1.4 "Sidebar icon color transitions"
```

### Session Start vs Session End

**Session Start** (first thing you do):
1. `git pull` — sync with remote
2. Read the 6 mandatory docs ONCE (Constitution → Master Plan → Status → Executive Decisions → Build Plan → Roadmap)
3. Open tracker in canvas
4. Query SQL for ready todos
5. Pick first task

**Session End** (last thing you do):
1. Push any remaining commits
2. Update `STATUS.md` with what was accomplished this session
3. Update tracker to reflect final state
4. Save all artifacts to `files/`
5. The checkpoint system auto-saves a checkpoint

### Session Artifacts Directory

Every session has this permanent folder:
```
C:\Users\<username>\.copilot\session-state\<session-uuid>\
├── checkpoints/          ← 75+ auto-created checkpoints (one per milestone)
│   └── index.md          ← Index with titles, dates, descriptions
├── files/                ← YOUR persistent artifacts
│   ├── ui-implementation-tracker.md   ← The main tracker
│   ├── 01-executive-summary.md        ← Project overview
│   ├── 02-project-history.md          ← What happened before
│   ├── 03-architecture.md             ← Architecture decisions
│   └── ...
```

**The `files/` directory is where you save EVERYTHING that needs to persist across turns.** Write your tracker there, then open it in the canvas:
```
open_canvas({ canvasId: "editor", instanceId: "tracker", input: { filePath: "C:/Users/Harvey/.copilot/session-state/d7dd471a-142c-4c3a-84b2-7d209fc07320/files/ui-implementation-tracker.md" } })
```

The user sees the tracker in the right sidebar updating in real time as you edit the file.

---

## Commit Format

```
type(scope): short imperative description

Optional body with details.

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`
Scope: `desktop`, `mobile`, `core`, `ui`, `docs`

---

## Design Rules (Non-Negotiable)

1. **Every visual element cites a source**: Gemini, ChatGPT, or Copilot
2. **Never invent**: colors, spacing, fonts, animations all trace to real products
3. **Phosphor Icons only**: Regular weight 20px default, Fill weight for active states
4. **CSS custom properties**: `var(--accent)` not `#6366f1`; always provide fallbacks
5. **Accessibility**: 40px touch targets, aria-labels, reduced motion, high contrast

---

## Handling Blockers

When something can't be done:

1. **Document the blocker** — what exactly is preventing progress?
2. **List alternatives** — what did you consider?
3. **State what unblocks it** — macOS machine? API key? Dependency update?
4. **Add to tracker** — mark the item `⏸️ BLOCKED` with the reason
5. **Add to EXECUTIVE_DECISIONS.md** — if it needs a product decision
6. **Move to the next task** — never idle on a blocker

Example blocker entry:
```
⏸️ BLOCKED: iOS testing requires macOS with Xcode.
Alternatives: cloud CI (Azure DevOps macOS agent), local Mac Mini.
Unblocks: provision macOS environment or defer iOS testing to post-launch.
```

---

## Anti-Patterns (What NOT to Do)

| ❌ Don't | ✅ Do |
|---|---|
| Start coding before reading the constitution | Read all mandatory docs first |
| Accumulate 5 commits locally before pushing | Push after every commit |
| Invent a new color scheme | Copy Gemini/ChatGPT/Copilot color systems |
| Use emoji for icons | Use Phosphor Icons with aria-labels |
| Hardcode `#e5484d` for danger | Use `var(--danger, #e5484d)` |
| Mark a task done without building | Build + typecheck before every commit |
| Silently downgrade an executive decision | Document the blocker and request guidance |
| Use `git branch -m` to rename | Use `rename_branch` tool in Copilot |
| Start a new feature while blocked | Move to next unblocked task |

---

## Quality Gates

Before considering any phase complete:

- [ ] `pnpm tsc --noEmit` passes with 0 errors
- [ ] `pnpm build` succeeds with 0 warnings
- [ ] All items in the phase marked ✅ in tracker
- [ ] All commits pushed to remote
- [ ] No hardcoded colors without `var()` fallback
- [ ] All interactive elements have 40px+ touch targets
- [ ] All icon-only elements have aria-labels
- [ ] Reduced motion toggle disables all animations
- [ ] CSS has no esbuild warnings

---

*Part of the [Copilot Project Methodology](./README.md) — a living document.*