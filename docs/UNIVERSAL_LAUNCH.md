# Agent Web Graph / NexusOS — Universal Substrate Launch

## Overview
NexusOS transforms Agent Web Graph from a browser-only web crawler into a **Universal Cross-Substrate Accessibility & Kinetic Operating System**. AI agents can now discover, inspect, and kinetically manipulate:
1. **Web Apps**: via WebDriver BiDi (Firefox / Chromium)
2. **Native Desktop Apps**: via Windows Direct UI Automation (UIA) & macOS Accessibility API (AXUIElement)
3. **Mobile Apps**: via Android Direct ADB / UIAutomator2 & iOS WebDriverAgent (WDA)

All substrates normalize their native node hierarchies into the unified **AxTreeNode** schema, enabling the exact same semantic query engine (`graph_query`), pathfinder (`graph_path`), and kinetic dispatch engine across any digital surface.

---

## Architecture & Substrate Layers

```
┌──────────────────────────────────────────────────────────┐
│                   AI Agent / Host LLM                     │
│           (Claude Desktop, Cursor, Autonomous Agent)      │
└───────────────────────────▲──────────────────────────────┘
                            │ Model Context Protocol (MCP) / CLI
┌───────────────────────────┴──────────────────────────────┐
│                    NexusOS Core Engine                    │
│    • Universal Graph Engine      • Semantic Query Engine   │
│    • Kinetic Dispatch Engine     • Normalizer Pipeline     │
└──────┬────────────────────┬────────────────────┬─────────┘
       │                    │                    │
┌──────▼──────┐      ┌──────▼──────┐      ┌──────▼──────┐
│  Web BiDi   │      │   Desktop   │      │   Mobile    │
│  Substrate  │      │  Substrate  │      │  Substrate  │
│             │      │             │      │             │
│  • Firefox  │      │  • Win UIA  │      │  • ADB/UIA2 │
│  • Chrome   │      │  • macOS AX │      │  • iOS WDA  │
└─────────────┘      └─────────────┘      └─────────────┘
```

---

## MCP Server Integration

To launch the MCP server with desktop and mobile substrates enabled:

```bash
# Serve with Desktop and Mobile tools enabled
pnpm awg serve --desktop --mobile

# Serve desktop only without requiring local geckodriver
pnpm awg serve --desktop --no-bidi
```

### Available MCP Tools

| Tool | Substrate | Description |
|------|-----------|-------------|
| `graph_query` | Universal | Query accessible elements by role, accessible name, or state |
| `graph_path` | Universal | Compute traversal paths between UI elements |
| `desktop_list_windows` | Desktop | List all open application windows (windowId, title, bounds) |
| `desktop_scrape_window` | Desktop | Scrape full accessibility tree of a target desktop window |
| `desktop_kinetic_action` | Desktop | Dispatch clicks, right clicks, hotkeys, window focus, or state |
| `mobile_list_devices` | Mobile | List attached Android / iOS devices or emulators |
| `mobile_scrape_device` | Mobile | Scrape active mobile screen into canonical AxTreeNode tree |
| `mobile_touch_action` | Mobile | Dispatch tap, swipe, text entry, or Android keyevent |

---

## CLI Command Reference

### Desktop Automation
```bash
# List all active desktop application windows
pnpm awg desktop --list

# Scrape an active desktop window by title pattern
pnpm awg desktop --scrape "Visual Studio Code" --depth 4 --out ./vscode-scrape.json
```

### Mobile Automation
```bash
# Discover attached Android devices/emulators via ADB
pnpm awg mobile --devices

# Scrape current active mobile screen
pnpm awg mobile --scrape emulator-5554 --out ./mobile-screen.json
```

---

## Verification & Status
- **TypeScript**: Strict compilation passed with 0 errors across all modules.
- **Unit & Integration Tests**: the authoritative tally is **generated**, not
  hand-written. Run `pnpm test && pnpm verify:emit` and cite
  [`docs/VERIFICATION.md`](VERIFICATION.md). (Audit finding F2: this file
  previously claimed "53 test suites passed (763 tests passed)", which
  disagreed with the 442/442, 582 and 725 tallies recorded elsewhere in
  `docs/`. Hand-written numbers are prohibited by
  `FINAL_PRODUCT_AND_ARCHITECTURE_DECISION.md` §32.)
- **Native Interop**: Zero external native C++/node-gyp dependencies; uses built-in OS libraries (.NET UIAutomation on Windows, native ADB CLI for Android).
