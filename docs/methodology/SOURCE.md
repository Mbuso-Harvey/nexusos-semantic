# Source — Working Methodology

The documents in this directory are the **working methodology** for the
Agent Web Graph project, authored by **Mbuso-Harvey**.

- **Source repository:** https://github.com/Mbuso-Harvey/copilot-project-methodology
- **Committed here:** 2026-08-30, in PR-4
- **Files included:** 8 (`README.md` + 6 numbered chapters + `PROMPTS.md`)

## What these are

The methodology defines the **operating system for building software with
AI agents**. It covers: how to onboard to a project, the 6 mandatory
documents every project must have, the commit discipline, design-by-
reference rules, the plan → approve → autopilot pipeline, multi-agent
orchestration, and 25+ recovery recipes.

## How Agent Web Graph uses it

- **`PROJECT_CONSTITUTION.md`** (root of this repo) is a direct
  application of `02-starting-fresh.md` §0.3 (the 6-section template).
- **`docs/MASTER_PLAN.md` / `STATUS.md` / `EXECUTIVE_DECISIONS.md` /
  `BUILD_PLAN.md` / `ROADMAP.md`** are the 5 mandatory docs per
  `02-starting-fresh.md` §0.2 ("Create them in this exact order").
- **The `feat/PR-N-{description}` branch pattern** follows
  `01-taking-over-a-project.md` §"Branch Strategy" and the
  subatomic PR rule.
- **The first-commit-is-docs rule** (PR-1 has no source code) is
  from `01-taking-over-a-project.md` §Step 5: *"Never start with a
  feature change. Your first commit proves you understand the
  project's toolchain."*
- **ED-01..ED-05 in `EXECUTIVE_DECISIONS.md`** use the methodology's
  `EXECUTIVE_DECISIONS.md` template (Step 0.6): Date / Decision /
  Rationale / Impact / Alternatives Considered.
- **The constitution rule** ("no recommendations against the
  constitution without explicit flagging") is an extension of the
  methodology's invariant that the constitution is the highest
  authority.

## Why we committed the methodology to the repo

Three reasons:

1. **The repo must be self-describing.** Anyone reading it must be
   able to find the process that produced it, not be told to look
   somewhere else.
2. **Future agents that join the project (human or AI)** read the
   methodology alongside the constitution, in the same place.
3. **Drift prevention.** The methodology evolves; if we ever fork
   the process, the divergence is visible in git history.

## Filename note

The committed files retain the `.md.md` extension they had when
read from the local source directory on 2026-08-30. This is
intentional — the byte-identical commit (test gate for PR-4)
proves no content was edited in transit. The double extension is
cosmetic; if you want a rename PR, that is PR-4.5 (not in scope
for the current plan).

## License

The methodology is owned by Mbuso-Harvey and is committed here by
explicit permission of the project owner. The methodology's own
license is preserved in the source repository.
