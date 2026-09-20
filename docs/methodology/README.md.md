# Copilot Project Methodology

> **The operating manual for building software with GitHub Copilot — systematically, trackably, and at production quality.**

---

## Quick Navigation

| You want to... | Read this |
|---|---|
| Onboard an agent to an existing project | [`01-taking-over-a-project.md`](./01-taking-over-a-project.md) |
| Start a brand new project from zero | [`02-starting-fresh.md`](./02-starting-fresh.md) |
| Design UI/UX that looks professional | [`03-ui-ux-design-methodology.md`](./03-ui-ux-design-methodology.md) |
| Understand every available tool | [`04-copilot-tools-reference.md`](./04-copilot-tools-reference.md) |
| **The complete agent operating manual** | [`05-agent-methodology-playbook.md`](./05-agent-methodology-playbook.md) |
| Orchestrate multiple agents on one project | [`06-multi-agent-orchestration.md`](./06-multi-agent-orchestration.md) |
| Just give me the prompt to paste | [`PROMPTS.md`](./PROMPTS.md) |
| See a real example tracker (255 items) | [`examples/ui-implementation-tracker.md`](./examples/ui-implementation-tracker.md) |

---

## Why This Exists

GitHub Copilot is a powerful tool, but power without process creates chaos. This repository captures the methodology refined across multiple production projects — the patterns that consistently produce organized, trackable, high-quality output.

### The Core Principles

1. **Read before you write** — always consume the project constitution, master plan, status, and executive decisions before making changes
2. **Track everything visibly** — save a markdown implementation tracker in the session artifacts directory, open it in the canvas side panel, and update it after every commit
3. **Commit atomically** — one logical change per commit, pushed immediately; never accumulate local work
4. **Copy, don't invent** — every design decision references a real, successful product (Gemini, ChatGPT, Copilot)
5. **Block decisively** — when something can't be done, document the exact blocker and move to the next task
6. **Use the session artifacts directory** — all plans, trackers, and decision documents live in `C:/Users/<user>/.copilot/session-state/<uuid>/files/` where they persist across turns and can be reopened in the canvas

### What This Methodology Gives You

- **Repeatability**: Every project follows the same structure. Agents produce consistent results.
- **Visibility**: The tracker canvas panel shows exact progress at a glance — every item is atomic and independently verifiable.
- **Recoverability**: Checkpoints + session artifacts + atomic commits + pushed work = impossible to lose progress.
- **Scalability**: Phase-based branching lets multiple agents work in parallel without conflicts.
- **Quality**: Design-by-reference means the UI looks like products people already trust.
- **Auditability**: Every tracker item has an inspiration source. Every blocker has a documented reason. Every commit maps to a tracker item.

---

## Tool Requirements

Some methodology features require Copilot-specific capabilities:

| Feature | Copilot CLI | Copilot Chat (VS Code) | Standard AI Tools |
|---|---|---|---|
| Canvas side panel (tracker widget) | ✅ | ✅ | ❌ |
| SQL session database (todos) | ✅ | ✅ | ❌ |
| Worktree sessions / branching | ✅ | ❌ | ❌ |
| Sub-agents (task, explore, review) | ✅ | ✅ | ❌ |
| Cross-session messaging | ✅ | ✅ | ❌ |
| Session artifacts directory | ✅ | ✅ | ❌ |
| Automatic checkpoints | ✅ | ❌ | ❌ |

**Portable fallback**: Even without these tools, the core methodology works. Replace the canvas tracker with a checked-in `TRACKER.md`. Replace SQL todos with markdown checklists. Replace the session artifacts directory with a `docs/` folder in the repo. The principles are environment-agnostic.

---

## The Complete Document Inventory

Every project MUST have these six documents. They are non-negotiable:

| # | Document | Purpose | Update Frequency |
|---|---|---|---|
| 1 | `PROJECT_CONSTITUTION.md` | The law — rules, invariants, commit discipline | Rarely (only when rules change) |
| 2 | `docs/MASTER_PLAN.md` | Numbered phases, what ships when | Rarely (scope/timeline changes) |
| 3 | `docs/STATUS.md` | Living state: done, in progress, blocked | **End of every session** |
| 4 | `docs/EXECUTIVE_DECISIONS.md` | Locked binding decisions vault | When new decision is made |
| 5 | `docs/BUILD_PLAN.md` | Concrete build order + dependency graph | When build structure changes |
| 6 | `docs/ROADMAP.md` | Timeline view of phases | When timelines shift |

**Plus the session-level artifact**:
| 7 | `files/ui-implementation-tracker.md` | Atomic task breakdown with status | **After every commit** |

---

## Getting Started

1. **First time?** Read `02-starting-fresh.md` to understand the full methodology.
2. **Want the complete playbook?** `05-agent-methodology-playbook.md` — the definitive **Commercial Edition v2.0** operating manual. 14 chapters + 3 appendices covering: Philosophy, the 6-Document System, Session Startup Ritual, Planning & Tracking, Architecture-First Development, Design-by-Reference, the Commit-Push-Tracker Cycle, Tool Usage & Power Patterns, Error Recovery, Handoff Protocol, Quality Standards, Prompt Templates, Multi-Agent Scaling, and the Golden Rules — plus real examples, cheat sheets, and a troubleshooting guide with 25+ fixes.
3. **Taking over?** Read `01-taking-over-a-project.md` for the onboarding sequence.
4. **Need a prompt?** Copy from `PROMPTS.md` and paste it to your agent.
5. **Struggling with design?** `03-ui-ux-design-methodology.md` has the answer.
6. **Want to know what tools are available?** `04-copilot-tools-reference.md` catalogs everything.
7. **Want to see what success looks like?** `examples/ui-implementation-tracker.md` is the actual 255-item tracker from a completed project.

---

## How the Session Artifacts Directory Works

Every Copilot session has a dedicated folder that persists across turns:

```
C:\Users\<username>\.copilot\session-state\<session-uuid>\
├── checkpoints/          ← Auto-created at major milestones
│   └── index.md          ← Index of all checkpoints
├── files/                ← YOUR artifacts — save trackers, plans, diagrams here
│   ├── ui-implementation-tracker.md
│   ├── 01-executive-summary.md
│   └── ...
```

**This is where you save the implementation tracker.** Write it to `files/`, then open it in the canvas:

```
open_canvas({ canvasId: "editor", instanceId: "tracker", input: { filePath: "C:/Users/.../files/ui-implementation-tracker.md" } })
```

The user sees the tracker in the right sidebar updating in real time as you edit the file.

---

*Maintained as a living document. If a pattern proves itself across multiple projects, it belongs here.*