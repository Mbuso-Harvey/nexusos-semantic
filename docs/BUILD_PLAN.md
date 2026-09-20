# Build Plan

## Dependency Graph
```
P0 (PR-1: foundation) → P1 (PR-2: brief)
                        → P2 (PR-3: source)
                        → P3 (PR-4: methodology)
                        → P4 (PR-5: gap analysis)
                        → P5..P9 (PR-6..PR-10: gap closure)
```
Each P depends on the previous; PRs are not parallelized
in the first pass. After P4, gap-closure PRs are planned
one at a time per the methodology's "atomic, independently
testable" rule.

## Build Commands
```bash
pnpm install                 # workspace setup
pnpm exec tsc --noEmit       # typecheck (must be 0 errors)
pnpm test                    # vitest (must be 100% passing)
pnpm run check-env           # BiDi substrate probe (must exit 0)
pnpm build                   # production build (must be 0 errors / 0 warnings)
```

## Test Gate Per PR
- **PR-1:** document review (no source).
- **PR-2:** byte-equal to the brief sent in the user's
  two messages this session.
- **PR-3:** `pnpm install && pnpm exec tsc --noEmit && pnpm test && pnpm run check-env` all pass.
- **PR-4:** `diff` against `C:\Users\Harvey\AppData\Local\Temp\methodology\` source files is empty.
- **PR-5:** every claim in GAP-ANALYSIS.md is backed by a
  `file:line` reference in the imported source tree.

## Quality Gates (Constitution §6)
- TypeScript: 0 errors.
- Tests: 100% passing.
- Build: 0 warnings.
- Commits: format-compliant, trailer present, pushed.
