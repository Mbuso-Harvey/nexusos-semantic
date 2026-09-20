# NexusOS Semantic Substrate

> **The Universal Semantic Operating Substrate for AI Web & Mobile Agents.**  
> Stop clicking pixels. Give your AI agents direct semantic and accessibility-tree control.

[![Model Context Protocol](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-green.svg)](LICENSE)

---

## What is NexusOS Semantic Substrate?

Modern AI agents struggle with web and mobile interfaces because they rely on screenshot OCR, fragile pixel-clicking, and raw DOM dumps that overflow LLM context windows.

**NexusOS** provides a **clean, structured semantic graph** of any web or mobile interface via the standard **Model Context Protocol (MCP)**. Instead of taking screenshots and guessing coordinates, your agent queries an interactive state graph with full accessibility semantics, design tokens, and executable capabilities.

```
  ┌────────────────────────────────────────────────────────┐
  │   AI Agent (Claude Desktop, Cursor, Custom Agent)      │
  └───────────────────────────┬────────────────────────────┘
                              │ Standard MCP (stdio / json-rpc)
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │              NexusOS Semantic Substrate                │
  │   • graph_query   — Semantic element & state search    │
  │   • graph_path    — Graph navigation & parent/child    │
  │   • graph_tool    — Discover actionable capabilities   │
  │   • graph_invoke  — Execute live actions on page       │
  │   • graph_explain — Context & provenance walk          │
  └───────────────────────────┬────────────────────────────┘
│   • desktop_list_windows — List native application windows   │
│   • desktop_scrape_window — Scrape window accessibility tree │
│   • desktop_kinetic_action — Dispatch human-like clicks/keys │
│   • mobile_list_devices  — Enumerate Android/iOS devices     │
│   • mobile_scrape_device — Scrape active mobile screen       │
│   • mobile_touch_action  — Dispatch kinetic touch & gestures │

                              │
                              ▼
                     Live Browser / Device
```

---

## ⚡ 1-Click Quickstart

### 1. Add to Claude Desktop

Add this to your `claude_desktop_config.json` (located at `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "nexusos": {
      "command": "npx",
      "args": ["-y", "@nexusos/substrate", "serve"]
    }
  }
}
```

> **Note:** the npm package is not yet published. Until it is, build from source and point the config at the compiled CLI (R6 wired `bin` to `dist/src/cli/awg.js`):
>
> ```json
> {
>   "mcpServers": {
>     "nexusos": {
>       "command": "node",
>       "args": ["/path/to/nexusos-semantic/dist/src/cli/awg.js", "serve", "--graph", "/path/to/substrate-dir"]
>     }
>   }
> }
> ```
>
> `serve` requires an explicit `--graph <dir>` and refuses to start without one — there is no default substrate.

Restart Claude Desktop, and the NexusOS tools will be immediately available in your chat!

---

### 2. Standalone CLI Usage

#### Install
```bash
git clone https://github.com/nexusos-ai/semantic-substrate.git
cd semantic-substrate
pnpm install
pnpm build
```

#### Crawl any website to build a semantic graph:
```bash
pnpm awg crawl "https://example.com" --out ./my-crawl --max-pages 5
```

#### Inspect elements without a browser:
```bash
# Find all primary buttons on the site
pnpm awg query graph_query '{"select":"ax-node","where":{"role":"button"}}' --graph ./my-crawl
```

#### Start the MCP Server:
```bash
pnpm awg serve --graph ./my-crawl
```

---

## 🛠️ The MCP Tool Surface

The server registers **18 MCP tools by default** — 6 core graph tools + `substrate_info` + `graph_diagnostics` + 10 visual/token tools. Opt-in substrates extend the surface to **33** (desktop +3, Chrome/CDP +6, mobile +3, crawl jobs +3). Crawl is **not** one of them — producing a substrate is a CLI/library job (`awg crawl`); the server serves an already-built graph directory. `graph_act` is **decision-only** (it returns what *would* be executed via the capability-tier gate); `graph_invoke` is the execute path.

> **Opt-in substrate production (R5):** with `--allow-crawl`, the server also registers `crawl_start` / `crawl_status` / `crawl_cancel` — async background crawl jobs with an atomic publish guarantee and a handle carrying the computed `graphHash` and producer identity.

**Core graph tools (7) + provenance (1):**

| Tool | Description |
|---|---|
| `substrate_info` | Provenance of the served graph: `rootUrl`, crawl timestamps, computed `graphHash` (sha256 of the served `graph.json`), build version. Call this first and assert on it. |
| `graph_query` | Find elements, pages, or state transitions by semantic role (`button`, `dialog`, `combobox`), name, or route. |
| `graph_path` | Traverse the UI hierarchy (`children`, `parent`, `descendants`, `ancestors`, or shortest navigation path). |
| `graph_tool` | List actionable capabilities detected on the page with security tier classifications (`READ`, `EXECUTE`, `CONFIRM`). |
| `graph_act` | **Decision-only** — returns the execution decision for a capability; does not execute. |
| `graph_invoke` | Safely execute an action (click, fill, toggle) on the live page and observe resulting state changes. |
| `graph_explain` | Get full accessibility context and neighborhood relations for any element ID. |
| `graph_diagnostics` | Graph health: page/AX/capability/state counts, health score, substrate availability (BiDi/desktop/mobile). |

**Substrate tool groups (22):** visual intelligence (10: `get_visual`, `query_viewport_diff`, `get_visual_patterns`, `query_page_layout_mutations`, `get_visual_containers`, `get_spatial_neighbors`, `get_occluded_nodes`, `query_visual_regression`, `lint_design_tokens`, `export_dtcg_tokens`), desktop (3: `desktop_list_windows`, `desktop_scrape_window`, `desktop_kinetic_action` — registered with `--desktop`), Chrome/CDP (6: `chrome_targets`, `chrome_read_tab`, `chrome_snapshot_tab`, `chrome_get_cookies`, `chrome_navigate`, `chrome_launch`), and mobile (3: `mobile_list_devices`, `mobile_scrape_device`, `mobile_touch_action` — registered with `--mobile`).

---

## 🔒 Security & Safe Execution Tiers

NexusOS enforces strict security tiers on all capabilities:
- **`DISCOVER` / `READ`**: Safe queries and read operations (executed automatically).
- **`EXECUTE`**: Standard user interactions (clicking a tab, typing in search).
- **`CONFIRM`**: Sensitive operations (checkout, account deletion, balance transfer) requiring explicit user approval.

---

## 🌐 Community & Commercial Platform

- **Open Source Substrate:** Free for local developer use, Claude Desktop integration, and open agents.
- **NexusOS Cloud & Enterprise:** High-scale headless fleet management, mobile device clouds (iOS & Android), anti-bot kinetic engine, and enterprise multi-tenancy. Visit [nexusos.dev](https://nexusos.dev) for enterprise access.

---

## License

Apache-2.0 © 2026 NexusOS Authors.
