# Prompt Templates for Copilot Agents

Four battle-tested prompts refined from multiple production projects.

---

## Prompt 0: THE UNIVERSAL STARTUP PROMPT (Use for EVERY new session)

```
Start in plan mode. Explore the repo thoroughly — read the constitution,
master plan, status, executive decisions, build plan, and roadmap.
Understand the architecture, read recent commits and open issues/PRs.
Then create a detailed plan with subatomic tasks. Every task must be
a single verifiable action. Open the plan in the canvas widget for
me to review and approve BEFORE any implementation code is written.

DO NOT start coding until I approve the plan.
```

**When to use**: Every single time you start a new session — whether it's a new
project, an existing project, a bug fix, or a feature addition.

**Why**: This forces the plan widget to appear. You see exactly what the agent
intends to do before it writes a single line of code. You catch hallucinations
early. Trust is maintained.

---

## Prompt 1: Starting a NEW Project (Fresh, No Files)

```
You are taking on a brand new project. There are no existing files.
Your job is to set up the project structure and planning artifacts
BEFORE writing any implementation code.

PHASE 0 — Project Setup (do this first, commit after each step):

Step 1: Create the project constitution
Create docs/PROJECT_CONSTITUTION.md containing:
- One-sentence summary of what this project is
- Binding product rules (5-10 rules)
- Architectural invariants (things that MUST be true)
- Technology choices and why
- What this project is NOT (anti-scope)

Step 2: Create the master plan
Create docs/MASTER_PLAN.md containing:
- Complete feature list organized by phase
- Each phase: clear deliverables and acceptance criteria
- Architecture diagram (use mermaid)
- Technology stack per phase

Step 3: Create the roadmap
Create docs/ROADMAP.md containing:
- Priority order (what to build first, second, third)
- Estimated sizing per phase (S/M/L/XL)
- Dependencies between phases

Step 4: Create the build plan
Create docs/BUILD_PLAN.md containing:
- How each phase will be built
- Which packages/modules will be created
- API contracts between modules

Step 5: Create the tracker
Create a detailed implementation tracker with EVERY single
implementation task. Each task gets:
- Unique ID (e.g., P1-01, P2-03)
- Description of WHAT to build
- Reference to the plan section
- Status: ⬜ PENDING
- Inspiration source (which product pattern to follow)

Use `render_widget` to create a visible side panel showing the tracker.

Step 6: Create executive decisions
Create docs/EXECUTIVE_DECISIONS.md (initially empty or with
any decisions already made).

PHASE 1 — Design System (for UI projects):

Step 7: Pick 3 industry-leading products in this category
Study their design patterns and document:
- Layout patterns (from Product A)
- Color system (from Product B)
- Animation/motion (from Product C)
- Typography (from Product A)
- Component anatomy (specific measurements from each)

Step 8: For every screen/component, the spec MUST say:
"ChatGPT 2025 chat bubble pattern: 18px border-radius, 250ms ease-out"
NOT "A nice chat bubble"

RULES:
- Commit after EVERY document is written
- Push after EVERY commit
- NEVER start implementation until all planning docs are complete
- NEVER design from scratch — always reference real products
- All decisions go in EXECUTIVE_DECISIONS.md
- After this setup, follow the standard commit-push-tracker cycle
```

---

## Prompt 2: Taking Over an EXISTING Project

```
You are taking over an existing project. Someone else built it.
Your job is to understand what exists and continue where they left off.

MANDATORY STARTUP RITUAL — read these IN ORDER before any action:

1. docs/PROJECT_CONSTITUTION.md
   → What is this project? What are the binding rules?

2. docs/MASTER_PLAN.md
   → What is the full scope? What phases exist?

3. docs/STATUS.md
   → What did the last agent complete? What's in progress?
   → What's broken? What's blocked?

4. docs/EXECUTIVE_DECISIONS.md
   → What decisions are LOCKED and CANNOT be changed?
   → DO NOT DOWNGRADE any capability listed here.
   → If something is hard, document the blocker — don't silently remove it.

5. docs/ROADMAP.md
   → What's the priority order?

6. docs/BUILD_PLAN.md
   → How are things being built?

After reading all 6:
- Read the tracker file (if it exists) to get exact X/Y/Z counts
- Read the last 10 commits to understand recent activity
- Read any open PRs or issues
- Check the current branch: `git branch --show-current`

ONLY THEN should you take action:
- Continue from where STATUS.md says to continue
- Follow the same commit-push-tracker cycle
- Update STATUS.md when you finish a phase
- NEVER change architecture without understanding it first

If STATUS.md is missing or stale:
- Create/update it immediately
- Audit what exists vs what the tracker says
- Report discrepancies to the human

RULES:
- Never downgrade capabilities from EXECUTIVE_DECISIONS.md
- Never skip the 6-document ritual
- Always push after every commit
- Always update tracker immediately
```

---

## Prompt 3: UI/UX Design for a Project

```
You are designing the UI/UX for [PROJECT NAME].

DESIGN METHODOLOGY:

Step 1: Pick your 3 inspirations
Identify the top 3 industry products in this category.
Examples: ChatGPT, Gemini, Claude (for AI chat)
          Notion, Linear, Superhuman (for productivity)
          Stripe, Vercel, GitHub (for developer tools)

Step 2: Assign ownership
For each design layer, pick which product to follow:

| Layer | Inspiration | Why |
|-------|-------------|-----|
| Layout & Navigation | ChatGPT 2025 | Tab-based, clean hierarchy |
| Color System (Light) | Microsoft Copilot | Neutral grey palette, blue accent |
| Color System (Dark) | Gemini 2025 | #0d1016 bg, higher contrast |
| Typography | ChatGPT | Inter, specific weights/sizes |
| Motion & Animation | Copilot Fluent | Ease-in-out, 200-300ms, reduced-motion |
| Iconography | Phosphor Icons | Regular weight, 20px default |
| Component Anatomy | ChatGPT 2025 | Bubble borders, suggestion chip sizes |

Step 3: For every component, write exact measurements
BAD:  "A rounded bubble with some padding"
GOOD: "ChatGPT 2025 bubble: 18px border-radius, 16px padding, max-width 70%,
        user: #5b8cff bg right-aligned, assistant: #f0f0f0 bg left-aligned,
        250ms appear animation ease-out, fade+slide 8px"

BAD:  "Dark mode with dark background"
GOOD: "Gemini dark mode: #0d1016 primary bg, #171a21 elevated surface,
        #f0f0f0 primary text, #7ba4ff accent, 80% contrast ratio minimum"

Step 4: Create component anatomy for every major component
For each component, document:
- Container: width, max-width, border-radius, shadow, padding
- Header area: font-size, font-weight, line-height, padding-bottom
- Content area: gap, alignment, overflow behavior
- Actions: button height, padding, font-size, touch-target (40px min)
- States: default, hover, active, disabled, loading, error
- Dark mode: every color gets a light AND dark value
- Accessibility: label, role, focus order

Step 5: Create the task breakdown
After the design spec is written, break every screen/component into
implementation tasks. Every task references:
- Which spec section it implements
- Which inspiration product/pattern it follows
- Exact measurements to implement

Step 6: Use the tracker
Create a visible side panel tracker with every task.
Mark progress as you implement.

CRITICAL RULES:
- NEVER design from scratch. Always reference real products.
- NEVER use vague measurements. Always exact px/ms values.
- ALWAYS design dark mode simultaneously with light mode.
- ALWAYS include accessibility in the spec (labels, roles, touch targets).
- EVERY color must have both light and dark variants.
```

---

## How to Use These Prompts

1. **New project:** Use Prompt 1 first. The agent will create all planning docs.
   Then use Prompt 3 if there's UI. Then Prompt 1 again for implementation.

2. **Existing project:** Use Prompt 2. The agent reads all docs and continues.
   No need for setup prompts.

3. **UI redesign:** Use Prompt 3 for the design spec. Then Prompt 2 for implementation.

4. **Recovery (agent went off track):** Use Prompt 2. The 6-document ritual
   forces them to re-read the rules and get back on track.

---

## The Key Insight

These prompts work because they:
1. **Force reading before writing** — the 6-document ritual prevents hallucination
2. **Reference real products** — agents can look up actual designs, not invent
3. **Demand exact measurements** — no room for vague interpretation
4. **Create visible tracking** — the side panel widget builds trust
5. **Enforce commit discipline** — commit-push-tracker cycle prevents data loss