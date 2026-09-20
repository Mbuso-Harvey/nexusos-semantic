# NexusOS Semantic

> **Universal Semantic Accessibility & Kinetic Substrate for AI Agents across Web, Native Desktop, and Mobile.**  
> Stop clicking pixels. Give artificial intelligence direct semantic and accessibility-tree control via standard Model Context Protocol (MCP).  
> Developed and maintained by **NexusOS Systems**.

[![Model Context Protocol](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-green.svg)](LICENSE)
[![Zero-Dependency SEA](https://img.shields.io/badge/Binary-Node_SEA_Standalone-purple.svg)](https://nodejs.org/api/single-executable-applications.html)

> **Status.** This is the canonical public repository for NexusOS Semantic.
> Quality is enforced by CI requiring the `Constitutional gates`
> check: typecheck, full test suite, BiDi substrate probe, production build.

---

## 💡 Why NexusOS Semantic?

Vision-based agents fail in real-world automation:
- **Context Bloat:** Transmitting high-resolution screenshots wastes thousands of tokens per step.
- **Coordinate Drift:** Responsive reflows, high-DPI scaling, and animations cause vision models to hallucinate click coordinates.
- **Silent Failures:** Agents cannot verify if a button was actually clickable, disabled, or occluded.

**NexusOS Semantic** solves this by normalizing any interface into a deterministic, queryable **Accessibility Graph (`AxTreeNode`)**:
- **100x Context Savings:** Agents consume compact ARIA hierarchies instead of megabytes of vision pixels.
- **Zero Hallucination:** Elements are selected by exact semantic identifiers, roles (`button`, `combobox`, `dialog`), and computed names.
- **Multi-Substrate Kinematics:** One canonical schema spans **Web browsers** (WebDriver BiDi / CDP), **Native Desktop windows** (Windows UIA / macOS AX), and **Mobile devices** (Android ADB / iOS WDA).

```
   ┌────────────────────────────────────────────────────────┐
   │    AI Agent (Claude Desktop, Cursor, Claude Code)      │
   └───────────────────────────┬────────────────────────────┘
                               │ Standard Model Context Protocol (stdio / JSON-RPC)
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │                   NEXUSOS SEMANTIC                     │
   │  • substrate_info— Substrate provenance & graph hash   │
   │  • graph_query   — Semantic element & state search     │
   │  • graph_path    — Graph navigation & shortest-path    │
   │  • graph_tool    — Discover executable capabilities    │
   │  • graph_act     — Execution decision (no execution)   │
   │  • graph_invoke  — Deterministic kinetic execution     │
   │  • graph_explain — Accessibility & neighborhood walk   │
   │  (+ visual / chrome / desktop / mobile tool groups)    │
   ├───────────────────────────┬────────────────────────────┤
   │                           │                            │
   ▼                           ▼                            ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Web Substrate   │  │Desktop Substrate │  │ Mobile Substrate │
│ WebDriver BiDi   │  │   Windows UIA    │  │   Android ADB    │
│  & Chrome CDP    │  │   macOS AX API   │  │   iOS WDA API    │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

## ⚡ Quickstart

### 1. Claude Desktop Integration

Add to your `claude_desktop_config.json`:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nexusos-semantic": {
      "command": "npx",
      "args": ["-y", "nexusos-semantic", "serve", "--desktop", "--mobile"]
    }
  }
}
```

### 2. Cursor IDE

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nexusos-semantic": {
      "command": "npx",
      "args": ["-y", "nexusos-semantic", "serve"]
    }
  }
}
```

### 3. Claude Code CLI

Register in one command:

```bash
claude mcp add nexusos-semantic -- npx -y nexusos-semantic serve
```

### 4. Smithery Registry

Run via the Smithery CLI:

```bash
npx -y @smithery/cli run nexusos-semantic
```

> **Note:** the npm package is not yet published. Until it is, build from source and register the compiled CLI directly:
>
> ```bash
> pnpm install && pnpm build
> claude mcp add nexusos-semantic -- node /path/to/nexusos-semantic/dist/src/cli/awg.js serve --graph /path/to/substrate-dir
> ```
>
> `serve` requires an explicit `--graph <dir>` and refuses to start without one — there is no default substrate.

---

## 🛠️ MCP Tool Capabilities

The server registers **18 MCP tools by default** — 6 core graph tools (`graph_query`, `graph_path`, `graph_tool`, `graph_act`, `graph_invoke`, `graph_explain`) + `substrate_info` + `graph_diagnostics` + 10 visual/token tools. Opt-in substrates extend the surface to **33**: desktop UIA (+3), Chrome/CDP (+6), mobile ADB (+3), and async crawl jobs (+3 via `--allow-crawl`). Crawl is **not** one of them by default — producing a substrate is a CLI/library job (`nexus crawl`); the server serves an already-built graph directory. `graph_act` is **decision-only**; `graph_invoke` is the execute path.

> **Opt-in substrate production (R5):** with `nexus serve --allow-crawl`, three more tools are registered — `crawl_start`, `crawl_status`, `crawl_cancel` — so an agent can trigger a crawl as a **background job** and receive a handle `{jobId, outputDir, graphHash, producer, state, ...}`. The substrate is published **atomically** (a failed or cancelled crawl never leaves a loadable partial directory), the `graphHash` on the completed handle is computed from the published `graph.json` bytes, and `crawl_start` is gated by the enforcement gateway as the `crawl` operation (impact `modify`).

| Tool | Category | Description |
| --- | --- | --- |
| `substrate_info` | Provenance | `rootUrl`, crawl timestamps, computed `graphHash` (sha256 of the served `graph.json`), build version. Assert on this before acting. |
| `graph_query` | Semantic Search | Query nodes by ARIA role (`button`, `combobox`, `searchbox`), name, or coordinates. |
| `graph_path` | Navigation | Traverse hierarchical tree relationships (`children`, `parent`, `descendants`, `shortest-path`). |
| `graph_tool` | Discovery | Enumerate actionable tools and declared capabilities exposed by the active interface. |
| `graph_act` | Decision | **Decision-only** — returns what *would* be executed (capability-tier gate); does not execute. |
| `graph_invoke` | Kinematics | Dispatch verified synthetic clicks, text fills, and keyboard events with safety validation. |
| `graph_live_read` | Live Web State | With BiDi attached, optionally navigate and safely snapshot document state plus one re-resolved CSS-selected element. |
| `graph_explain` | Introspection | Retrieve accessibility context, parent bounding boxes, and neighborhood relations. |
| `graph_diagnostics` | Health | Graph counts, health score, and substrate availability (BiDi / desktop / mobile). |
| `get_visual` … `export_dtcg_tokens` | Visual (10 tools) | Visual intelligence: viewport diffs, layout mutations, spatial neighbors, occlusion, visual regression, design-token lint/export. |
| `chrome_targets` … `chrome_launch` | Chrome/CDP (6 tools) | Attach to and read/act on Chrome via CDP, including cookie access. |
| `desktop_list_windows` | Desktop Substrate | Enumerate open top-level OS windows, process names, and window handles. |
| `desktop_scrape_window` | Desktop Substrate | Scrape native Windows UIA or macOS AX elements into canonical `AxTreeNode`. |
| `desktop_read_text` | Desktop Substrate | Read text from a freshly resolved Windows Document/Edit element via UI Automation. |
| `desktop_replace_text` | Desktop Substrate | Replace a Windows editor's full text and return its actual UI Automation read-back. |
| `desktop_kinetic_action` | Desktop Substrate | Dispatch native OS clicks and keyboard shortcuts to target windows. |
| `mobile_list_devices` | Mobile Substrate | List connected Android ADB devices/emulators and iOS WDA instances. |
| `mobile_scrape_device` | Mobile Substrate | Dump and parse the active mobile screen hierarchy into standard graph nodes. |
| `mobile_touch_action` | Mobile Substrate | Dispatch kinetic taps, swipes, text typing, and hardware buttons (Back, Home). |

---

## 💻 CLI & Standalone Executable (No Node.js Required)

NexusOS Semantic can be compiled into a zero-dependency **Single Executable Application (SEA)**:

```bash
# Clone and build.
git clone https://github.com/Mbuso-Harvey/nexusos-semantic.git
cd nexusos-semantic
pnpm install
pnpm build:sea

# Standalone binary is ready in dist/bin/nexus (.exe on Windows)
./dist/bin/nexus doctor
```

### Key CLI Commands

> **Note:** The CLI responds to both `nexus` and `awg` interchangeably.

```bash
# 1. Environment and substrate diagnostics
nexus doctor

# 2. Crawl a web app and persist state transitions
nexus crawl "http://localhost:3000" --out ./my-crawl --max-pages 10

# 3. Inspect graph health, broken states, and ARIA coverage
nexus inspect --graph ./my-crawl --diagnostics

# 4. Query graph without launching a browser
nexus query graph_query '{"select":"ax-node","where":{"role":"button"}}' --graph ./my-crawl

# 5. Start the MCP server over stdio
nexus serve --graph ./my-crawl --desktop --mobile

# 6. Diff two graph snapshots for visual regressions
#    (layout shift, dimension changes, style drift, occlusion, token detachment)
nexus diff ./baseline-crawl ./candidate-crawl --page "page:/" --json

# 7. Inspect design tokens: lint token drift (styling debt)
nexus tokens --graph ./my-crawl --lint

# 8. Export a standard W3C DTCG design-token bundle
nexus tokens --graph ./my-crawl --export-dtcg ./tokens.dto.json
```

---

## 🧪 Validation Evidence — the Evidence Ledger

Every claim that NexusOS Semantic works against real applications is backed
by machine-recorded evidence in [`verification/`](verification/):

- **[`verification/LEDGER.md`](verification/LEDGER.md)** — the summary table an
  auditor reads first: per-target verdicts, page/AX-node counts, health
  scores, and extractor diagnostics, regenerated deterministically by the
  runner from the committed per-target result files.
- **[`verification/targets/`](verification/targets/)** — the ratified target
  set, each with its recorded authorization basis: an owned synthetic app,
  self-hosted real OSS (OWASP Juice Shop, httpbin), and a hard-budgeted
  permissioned-public set (example.com, W3C ARIA APG).
- **`verification/results/`** — the full per-target run record, including the
  robots.txt authorization snapshot, container image digest, threshold
  checks, and the capability-battery transcript.

Run it yourself:

```bash
node scripts/run-ledger.mjs --list                 # the ratified target table
node scripts/run-ledger.mjs --target demo-saas     # one target, end-to-end
```

A nightly workflow (`.github/workflows/nightly-ledger.yml`) runs the full
battery with `--strict` and commits fresh evidence. Hand-editing generated
evidence is prohibited — the policy, including why bug bounty is *not* the
test strategy and how design-partner testing is authorized, is binding in
[`docs/EXECUTIVE_DECISIONS.md`](docs/EXECUTIVE_DECISIONS.md) (ED-09, ED-10).

---

## 🌐 Interactive Demo & Visual Explorer

The interactive visual explorer ships in-repository and runs locally — no
hosted site is required:

```bash
pnpm site          # serves site/ locally; open the printed URL
```

The explorer provides:
- Live visual graph query explorer
- Element coordinate vs ARIA role comparison
- 1-Click MCP client configurations

---

## 🔒 Security & Safe Execution Tiers

Every operation in NexusOS Semantic enforces strict safety tiers:
- **`READ`**: Passive reads, accessibility scraping, and graph walks (safe for autonomous execution).
- **`EXECUTE`**: Reversible interactions like form field entry or tab switching.
- **`CONFIRM`**: Sensitive operations requiring explicit human approval.

See [`SECURITY.md`](SECURITY.md) for full vulnerability reporting guidelines and sandboxing rules.

---

## 📜 Open Source Governance & License

- **License:** Distributed under the [Apache License 2.0](LICENSE).
- **Branding:** Governed by [`ED-07`](docs/EXECUTIVE_DECISIONS.md).
- **Contributing:** Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting pull requests.
- **Constitution:** Governed by the principles outlined in [`PROJECT_CONSTITUTION.md`](PROJECT_CONSTITUTION.md).


