# Contributing to NexusOS Semantic

Thank you for your interest in contributing to **NexusOS Semantic**! We welcome bug fixes, documentation improvements, new substrate drivers, and MCP tooling enhancements under the stewardship of **NexusOS Systems**.

---

## Code of Conduct

All contributors and participants are expected to maintain an inclusive, respectful, and professional environment across discussions, issue trackers, and pull requests.

---

## Development Setup

### Prerequisites

- **Node.js**: Version 22.0.0 or higher (Node 24 recommended)
- **pnpm**: Version 11.0.0 or higher
- **Git**: Installed and configured

### Installation

```bash
git clone https://github.com/Mbuso-Harvey/nexusos-semantic.git
cd nexusos-semantic
pnpm install
```

---

## Essential Commands

| Command | Purpose |
| --- | --- |
| `pnpm check-env` | Verifies node version and development environment integrity |
| `pnpm build` | Compiles TypeScript source files into `dist/` |
| `pnpm test` | Runs the full Vitest test suite |
| `pnpm build:sea` | Packages the standalone Single Executable Application (`dist/bin/nexus`) |
| `pnpm nexus doctor` | Runs end-to-end substrate and environment diagnostics |

---

## Architectural Principles

When submitting code to Agent Web Graph, please keep these principles in mind:

1. **Semantic First, Pixels Never:** Never introduce dependencies on vision OCR or raw screenshot pixel coordinates where accessibility primitives (roles, names, states) exist.
2. **Canonical Graph Normalization:** Whether an element originates from Chromium CDP, Windows UIAutomation, or Android ADB, it must normalize to `AxTreeNode`.
3. **Deterministic State Modeling:** Dynamic states (collapsible, popovers, modals) must produce verifiable graph edges.
4. **Safety Tiers:** Any new tool or executable action must declare an appropriate safety classification (`READ`, `EXECUTE`, or `CONFIRM`).

---

## Pull Request Guidelines

1. **Branch Naming:** Use clear branch names such as `fix/bidi-timeout`, `feat/ios-wda-driver`, or `docs/mcp-setup`.
2. **Tests Required:** Add or update unit tests covering your changes in `tests/`.
3. **Pass All Checks:** Ensure `pnpm check-env && pnpm build && pnpm test` completes with 0 errors before submitting.
4. **Licensing:** All contributions are distributed under the Apache License 2.0. Avoid adding personal attribution banners in file headers; all code belongs collectively to The Agent Web Graph Project Authors.
