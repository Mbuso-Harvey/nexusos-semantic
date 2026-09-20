# 04 — Copilot Tools Reference

> **What this is:** A complete catalog of every tool available in the GitHub Copilot
> CLI environment, what each tool does, when to use it, and concrete examples.
> **Who this is for:** Agents running in Copilot CLI or Copilot Chat. VS Code Copilot
> and other AI tools may have different capabilities — check your environment.

---

## Table of Contents

1. [File Operations](#file-operations)
2. [Search & Discovery](#search--discovery)
3. [PowerShell / Shell Execution](#powershell--shell-execution)
4. [Git & GitHub](#git--github)
5. [Session Management](#session-management)
6. [Canvas System](#canvas-system)
7. [SQL Session Database](#sql-session-database)
8. [Sub-Agents](#sub-agents)
9. [Task Tracking & Widgets](#task-tracking--widgets)
10. [Tool Selection Decision Tree](#tool-selection-decision-tree)

---

## File Operations

### `view` — Read files and directories

Displays file contents with line numbers, or lists directory contents.

**When to use**: Anytime you need to read a file. Use this, not grep, to read known files.

```
// Read an entire file
view({ path: "/repo/src/main.ts" })

// Read specific line ranges (MANDATORY for files > 20KB — they're truncated otherwise)
view({ path: "/repo/src/main.ts", view_range: [1, 50] })
view({ path: "/repo/src/main.ts", view_range: [100, 200] })

// Read to end of file
view({ path: "/repo/src/main.ts", view_range: [100, -1] })

// List a directory (shows 2 levels deep)
view({ path: "/repo/src/components/" })
```

**Tips**:
- Files > 20KB are truncated — ALWAYS use `view_range` for large files
- Make multiple `view` calls in ONE response — they run in parallel
- Don't use `view` to search for content — use `grep` for that

### `edit` — Make string replacements

Replaces EXACTLY ONE occurrence of `old_str` with `new_str` in a file.

**Rules**:
- `old_str` must match EXACTLY — same whitespace, same indentation, same blank lines
- Must be unique in the file (exactly one match)
- Include enough surrounding context to make it unique

```
// Batch multiple edits in ONE response (applied sequentially)
edit({ path: "src/users.ts", old_str: "let userId = guid();", new_str: "let userID = guid();" })
edit({ path: "src/users.ts", old_str: "userId = fetchFromDb();", new_str: "userID = fetchFromDb();" })
```

**Anti-pattern**: Do NOT delete-and-recreate a file with `create` to edit it. Always use `edit` for existing files.

### `create` — Create new files

Creates a NEW file. FAILS if the file already exists.

```
create({ path: "/repo/docs/TRACKER.md", file_text: "# Implementation Tracker\n\n..." })
```

**Never use `create` as a workaround for editing. Use `edit`.**

---

## Search & Discovery

### `grep` — Search file contents (ripgrep)

Fast regex search across file contents.

| Option | Effect |
|---|---|
| `pattern` | Regex to search for |
| `glob` | Filter by filename: `"*.tsx"`, `"*.{ts,tsx}"` |
| `output_mode: "files_with_matches"` | Only file paths (DEFAULT) |
| `output_mode: "content"` | Show matching lines |
| `output_mode: "count"` | Match counts per file |
| `-i` | Case-insensitive |
| `-n` | Show line numbers |
| `-A 3`, `-B 3`, `-C 3` | Context lines |
| `multiline: true` | Cross-line matching |

```
// Find files importing Phosphor
grep({ pattern: "@phosphor-icons/react", output_mode: "files_with_matches" })

// Find hardcoded colors (no var())
grep({ pattern: "#[0-9a-fA-F]{6}", glob: "*.tsx", output_mode: "content", "-n": true })

// Count test files
grep({ pattern: "describe\\(", output_mode: "count" })
```

### `glob` — Find files by name pattern

```
// All test files
glob({ pattern: "**/*.test.ts" })

// All React components
glob({ pattern: "**/*.{tsx,jsx}" })

// Package manifests
glob({ pattern: "**/package.json" })
```

**Best practice**: `glob` to find files → `view` to read them. Don't `grep` when you only need filenames.

---

## PowerShell / Shell Execution

### `powershell` — Run commands

| Mode | Behavior | When to Use |
|---|---|---|
| `sync` | Waits with `initial_wait` timeout (default 30s) | Most commands |
| `sync, initial_wait: 120` | Waits up to 120s | Builds, tests, installs |
| `async` | Background, notifies on completion | Long tasks to monitor |
| `async, detach: true` | Fully independent, survives session | Servers, daemons |

```
// Quick typecheck
powershell({ command: "pnpm tsc --noEmit", description: "TypeScript check" })

// Build with long wait
powershell({ command: "pnpm build", description: "Full build", initial_wait: 180, mode: "sync" })

// Dev server (persists after session)
powershell({ command: "pnpm dev", description: "Start dev server", mode: "async", detach: true, initial_wait: 10 })
```

**CRITICAL**: Each command runs in a FRESH process. Environment variables, working directory, and shell state DO NOT persist. For dependent steps:

```
// Chain with checks
powershell({ command: "cd /repo; pnpm build; if ($?) { pnpm test }", ... })
```

### `read_powershell` — Read output from running command

```
read_powershell({ shellId: "abc123", delay: 5 })
```

### `stop_powershell` / `list_powershell`

---

## Git & GitHub

### `create_pull_request` — Create a PR

```
create_pull_request({ title: "feat(P9): Add ThemeProvider", body: "...", draft: false })
```

### `create_issue` — File an issue

```
create_issue({ title: "iOS testing unavailable", body: "...", labels: ["blocked"] })
```

### `rename_branch` — Rename worktree branch

**ALWAYS use this. NEVER `git branch -m`.**
```
rename_branch({ name: "feat/P9-desktop-app" })
```

### `get_changes_overview` — Quick workspace snapshot

Merge-base, commit log, diff stats, changed files.

### `gh` CLI — For other operations

Use `gh` via PowerShell for PR viewing, issue listing, workflow runs, etc.

---

## Session Management

### Session Artifact Directory

Every session has a dedicated artifact directory at:

```
C:\Users\<username>\.copilot\session-state\<session-uuid>\
├── checkpoints/          ← Auto-created checkpoints (one per major milestone)
│   └── index.md          ← Index of all checkpoints with descriptions
├── files/                ← YOUR persistent artifacts directory
│   ├── ui-implementation-tracker.md
│   ├── 01-executive-summary.md
│   └── ...
```

**The `files/` directory is where you save trackers, plans, architecture diagrams, and any other artifacts that should persist across turns.**

It persists across the entire session at `C:/Users/<user>/.copilot/session-state/<session-uuid>/files/`.

### `create_session` — Spawn a parallel session

```
create_session({ 
  name: "iOS pipeline setup",
  kickoff: { prompt: "Set up iOS CI pipeline with Azure DevOps...", mode: "autopilot" }
})
```

### `send_session_message` — Message another session

```
send_session_message({ session_id: "abc-123", message: "Tracker updated, ready for review." })
```

### `rename_session` — Name the session

Do this early:
```
rename_session({ title: "Desktop app redesign" })
```

---

## Canvas System

The side panel where users see trackers, previews, and terminals.

### `open_canvas` — Open a side panel

```
// Editor canvas — shows markdown files
open_canvas({ canvasId: "editor", instanceId: "tracker", input: { filePath: "C:/Users/.../files/ui-implementation-tracker.md" } })

// Browser canvas — shows web preview
open_canvas({ canvasId: "browser", instanceId: "preview", input: { url: "http://localhost:5173" } })
```

| Canvas | Best For |
|---|---|
| `editor` | Implementation tracker, plans, specs (markdown) |
| `browser` | Previewing running app |
| `terminal` | Commands user should watch |

---

## SQL Session Database

Per-session SQLite database. Survives the session. Isolated from other sessions.

**Pre-existing tables**:
- `todos(id, title, description, status, created_at, updated_at)`
- `todo_deps(todo_id, depends_on)`

```sql
-- Insert task
INSERT INTO todos (id, title, description) VALUES ('creating-shimmer', 'Creating Shimmer', '5 variants + loading states');

-- Dependency: waiting-for-x depends on creating-x
INSERT INTO todo_deps (todo_id, depends_on) VALUES ('adding-shimmer-to-views', 'creating-shimmer');

-- Find ready tasks (all deps done)
SELECT t.* FROM todos t WHERE t.status = 'pending'
AND NOT EXISTS (SELECT 1 FROM todo_deps td JOIN todos dep ON td.depends_on = dep.id
WHERE td.todo_id = t.id AND dep.status != 'done');

-- Mark progress
UPDATE todos SET status = 'in_progress' WHERE id = 'creating-shimmer';
UPDATE todos SET status = 'done' WHERE id = 'creating-shimmer';
```

---

## Sub-Agents

### `task` — Launch specialized agent

| Agent Type | Best For | Side Effects? |
|---|---|---|
| `explore` | Codebase exploration, finding answers across files | No |
| `task` | Commands with verbose output (build, test, lint) | Yes |
| `general-purpose` | Complex multi-step tasks | Yes |
| `code-review` | Review diffs for bugs, security, logic errors | No |
| `research` | Search GitHub, fetch files, verify claims | No |
| `security-review` | Find exploitable vulnerabilities | No |

```
// Explore — find answers in codebase
task({ agent_type: "explore", name: "audit-icons", description: "Audit icon usage",
  prompt: "Find all Phosphor icon imports. List icon name, file, and whether it has aria-label.",
  mode: "sync" })

// Build task
task({ agent_type: "task", name: "desktop-build", description: "Build desktop",
  prompt: "Run `pnpm build`. Report success or full error output.",
  mode: "sync" })
```

**When NOT to use**: Reading known files → `view`. Simple grep → `grep`. ≤5 tool calls → do it yourself.

---

## Tool Selection Decision Tree

```
Need to...
├─ Read a known file? → view()
├─ Find files by name? → glob() → view()
├─ Search file contents? → grep()
├─ Edit a file? → edit() (NEVER delete+create)
├─ Create a new file? → create()
├─ Run a command? → powershell()
├─ Create a PR? → create_pull_request()
├─ Rename branch? → rename_branch()
├─ Open tracker panel? → open_canvas({ canvasId: "editor" })
├─ Track dependencies? → sql()
├─ Research codebase? → task({ agent_type: "explore" })
├─ Build/test? → task({ agent_type: "task" })
├─ Review changes? → task({ agent_type: "code-review" })
├─ Complex multi-step? → task({ agent_type: "general-purpose" })
└─ Need external info? → web_fetch() / web_search()
```

---

*Part of the [Copilot Project Methodology](./README.md).*