#!/usr/bin/env node
/**
 * emit-verification.mjs — generate `docs/VERIFICATION.md` from the JUnit XML
 * that vitest emits.
 *
 * **Audit finding F2.** The repository contained several mutually
 * inconsistent, hand-written test tallies:
 *
 *   - `docs/UNIVERSAL_LAUNCH.md`  -> "53 test suites passed (763 tests passed)"
 *   - `docs/AUDIT-PR-13.md`       -> "442/442 tests across 31 files"
 *   - `docs/CAPABILITY_AUDIT.md`  -> "582 passed, 4 failed, 10 skipped (45 files)"
 *   - `docs/PR-8d-audit.md`       -> "725 passed, 4 failed, 10 skipped (46 files)"
 *
 * Hand-written numbers drift the moment the suite changes, and the project's
 * own binding rule (`docs/FINAL_PRODUCT_AND_ARCHITECTURE_DECISION.md` §32)
 * forbids "marketing claims ahead of reality". This script makes the tally a
 * generated artifact instead of a claim.
 *
 * Usage:
 *   pnpm test                                    # emits test-results.junit.xml
 *   node scripts/emit-verification.mjs
 *   node scripts/emit-verification.mjs --require-green   # exit 1 on failures
 *   node scripts/emit-verification.mjs --check           # exit 1 if the
 *                                                         # committed file is
 *                                                         # stale (CI drift gate)
 *
 * The output is byte-for-byte DETERMINISTIC for identical test outcomes:
 * no timestamps, no durations, suites sorted by name. This is a
 * requirement, not a nicety — the CI drift gate regenerates the file and
 * compares it against the committed copy, so any hand-edit or stale tally
 * fails the build (ED-08 §6 / ED-09). The on-disk artifact
 * (`test-results.junit.xml`) retains the wall-clock details this file omits.
 *
 * No third-party dependencies: the JUnit dialect vitest emits is parsed with
 * targeted regular expressions.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const requireGreen = args.includes("--require-green");
const checkOnly = args.includes("--check");
const xmlArg = args.find((a) => !a.startsWith("--"));
const xmlPath = xmlArg ? resolve(xmlArg) : resolve(repoRoot, "test-results.junit.xml");
const outPath = resolve(repoRoot, "docs", "VERIFICATION.md");

if (!existsSync(xmlPath)) {
  console.error(`[emit-verification] missing ${xmlPath}`);
  console.error("[emit-verification] run `pnpm test` first (vitest.config.ts has the junit reporter).");
  process.exit(2);
}

const xml = readFileSync(xmlPath, "utf8");

/** Extract a numeric attribute from a tag, defaulting to 0. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

// Every <testsuite ...> opening tag.
const suiteTags = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map((m) => m[0]);
if (suiteTags.length === 0) {
  console.error("[emit-verification] no <testsuite> elements found; is this a JUnit file?");
  process.exit(2);
}

const suites = suiteTags.map((tag) => {
  const nameMatch = tag.match(/name="([^"]*)"/);
  return {
    name: nameMatch ? nameMatch[1] : "(unnamed)",
    tests: attr(tag, "tests"),
    failures: attr(tag, "failures"),
    errors: attr(tag, "errors"),
    skipped: attr(tag, "skipped"),
    time: attr(tag, "time"),
  };
});

// Platform/environment-gated tests (`it.runIf(<condition>)`) run only when
// their condition holds — e.g. the Windows UIA suites run on a Windows
// workstation and SKIP on the Linux CI runner. Including them makes the
// tally platform-dependent, which breaks the deterministic drift gate
// (ED-10 §7): two runs with identical outcomes on different platforms must
// produce identical files. Normalize by excluding gated tests from the
// tally on every platform. The gated-test count comes from a SOURCE SCAN
// of each suite file (deterministic, self-maintaining — the established
// test/server/naming-drift.test.ts pattern), never from executing anything.
function countPlatformGated(suiteName) {
  const src = resolve(repoRoot, suiteName);
  if (!existsSync(src)) return 0;
  try {
    const text = readFileSync(src, "utf8");
    return [...text.matchAll(/\bit\.runIf\s*\(/g)].length;
  } catch {
    return 0;
  }
}

// Raw totals (before normalization) — the cross-check below validates the
// XML parse against THESE numbers, so what is checked is the reporter's own
// internal consistency, not the platform-normalized tally.
const rawTotals = suites.reduce(
  (a, s) => ({
    tests: a.tests + s.tests,
    failures: a.failures + s.failures,
    errors: a.errors + s.errors,
    skipped: a.skipped + s.skipped,
    time: a.time + s.time,
  }),
  { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 },
);

for (const s of suites) {
  const gated = countPlatformGated(s.name);
  if (gated === 0) continue;
  s.tests = Math.max(0, s.tests - gated);
  s.skipped = Math.max(0, s.skipped - gated);
}

const totals = suites.reduce(
  (a, s) => ({
    tests: a.tests + s.tests,
    failures: a.failures + s.failures,
    errors: a.errors + s.errors,
    skipped: a.skipped + s.skipped,
    time: a.time + s.time,
  }),
  { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 },
);

// Count failure/error/skipped elements directly as a cross-check on the
// attributes, so a malformed reporter output cannot silently under-report.
const failureEls = [...xml.matchAll(/<(failure|error)\b/g)].length;
const skippedEls = [...xml.matchAll(/<skipped\b/g)].length;

const passed = Math.max(0, totals.tests - totals.failures - totals.errors - totals.skipped);
const bad = totals.failures + totals.errors;

// Deterministic output (ED-09): suite order in the JUnit file follows
// parallel execution order and varies run-to-run. Sort by name so two runs
// with identical outcomes produce identical files.
suites.sort((a, b) => a.name.localeCompare(b.name));

const lines = [];
lines.push("# Verification Report");
lines.push("");
lines.push("> **GENERATED FILE — DO NOT EDIT BY HAND.**");
lines.push(">");
lines.push("> Produced by `scripts/emit-verification.mjs` from `test-results.junit.xml`.");
lines.push("> Regenerate with `pnpm test && node scripts/emit-verification.mjs`.");
lines.push(">");
lines.push("> This file exists because hand-written test tallies drifted across");
lines.push("> `UNIVERSAL_LAUNCH.md`, `AUDIT-PR-13.md`, `CAPABILITY_AUDIT.md` and");
lines.push("> `PR-8d-audit.md` (audit finding F2). Cite this file, never a number");
lines.push("> copied into prose.");
lines.push("");
lines.push("> **This file is deterministic by design:** no timestamps, no");
lines.push("> durations, suites sorted by name. The CI drift gate");
lines.push("> (`node scripts/emit-verification.mjs --check`) regenerates it on");
lines.push("> every run and fails the build when the committed copy is stale or");
lines.push("> hand-edited.");
lines.push("");
lines.push("- **Source artifact:** `test-results.junit.xml`");
lines.push("- **Reporter:** vitest `junit` (see `vitest.config.ts`)");
lines.push("- Platform/environment-gated tests (`it.runIf(...)`): **excluded** from this tally (ED-10 §7) so a Windows workstation and the Linux CI runner produce identical files.");
lines.push("");
lines.push("## Totals");
lines.push("");
lines.push("| Metric | Value |");
lines.push("| --- | --- |");
lines.push(`| Test suites | ${suites.length} |`);
lines.push(`| Tests | ${totals.tests} |`);
lines.push(`| Passed | ${passed} |`);
lines.push(`| Failed | ${totals.failures} |`);
lines.push(`| Errors | ${totals.errors} |`);
lines.push(`| Skipped | ${totals.skipped} |`);
lines.push("");
lines.push("### Cross-check");
lines.push("");
// ED-10 §7: the RAW element counts are platform-dependent (platform-gated
// tests skip on the Linux CI runner and run on a Windows workstation), so
// printing them would make two identical-outcome runs on different
// platforms produce different files and break the drift gate. Print the
// consistency verdicts instead — the raw numbers live in the on-disk
// test-results.junit.xml (the wall-clock artifact).
lines.push(`- \`<failure>\`/\`<error>\` elements vs suite attributes: **${failureEls === bad ? "consistent" : "INCONSISTENT"}**`);
lines.push(`- \`<skipped>\` elements vs suite attributes: **${skippedEls === rawTotals.skipped ? "consistent" : "INCONSISTENT"}**`);
lines.push("");
if (failureEls !== bad || skippedEls !== rawTotals.skipped) {
  lines.push("> **WARNING:** element counts disagree with the suite attributes above.");
  lines.push("> Investigate before publishing these numbers.");
  lines.push("");
}
lines.push("## Per-suite breakdown");
lines.push("");
lines.push("| Suite | Tests | Pass | Fail | Err | Skip |");
lines.push("| --- | --- | --- | --- | --- | --- |");
for (const s of suites) {
  const p = Math.max(0, s.tests - s.failures - s.errors - s.skipped);
  lines.push(`| \`${s.name}\` | ${s.tests} | ${p} | ${s.failures} | ${s.errors} | ${s.skipped} |`);
}
lines.push("");
lines.push("## Interpreting failures");
lines.push("");
lines.push("A non-zero failure count is **not automatically a regression**. Per PR-8j T2,");
lines.push("the substrate-gated suites **hard-fail by design** when `AWG_REAL_BIDI` is");
lines.push("unset or geckodriver is unreachable on `127.0.0.1:4444`. The complete list");
lines.push("(ED-09 §6 — no prose may enumerate a subset):");
lines.push("");
lines.push("- `test/pr-8i/real-bidi-auth.test.ts`");
lines.push("- `test/pr-8i/real-bidi-choose-dropdown.test.ts`");
lines.push("- `test/server/invoke.test.ts` (PR-8i T2 posture: gated on `AWG_REAL_BIDI`)");
lines.push("- `test/pr-8f/convergence-trace.test.ts` (requires geckodriver on 4444)");
lines.push("- `test/e2e/real-app.test.ts` (also requires `AWG_CONVERGENCE_URL`, served by");
lines.push("  the synthetic demo server)");
lines.push("");
lines.push("They are mandatory and never silently skipped. A fully green run therefore");
lines.push("requires the substrate CI provides (Firefox + geckodriver under Xvfb, plus");
lines.push("the synthetic demo server for `AWG_CONVERGENCE_URL`).");
lines.push("");
lines.push("| Context | Expected result |");
lines.push("| --- | --- |");
lines.push("| CI (`Constitutional gates`) | 0 failures, 0 errors |");
lines.push("| Local workstation without the BiDi substrate | BiDi/E2E suites fail by design |");
lines.push("");

if (checkOnly) {
  // ED-08 §6 / ED-09 drift gate: regenerate in memory and compare against
  // the committed copy. Any hand-edit or stale tally fails the build.
  const committedRaw = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  // Line endings are normalized (git autocrlf on Windows checks out CRLF);
  // a hand-edit or stale tally is never just an EOL change.
  const committed = committedRaw === null ? null : committedRaw.replace(/\r\n/g, "\n");
  const regenerated = lines.join("\n");
  if (committed !== regenerated) {
    console.error("[emit-verification] --check FAILED: docs/VERIFICATION.md differs from this run's regenerated copy.");
    console.error("[emit-verification] the committed copy is stale or hand-edited (ED-08 §6 / ED-09)");
    console.error(`[emit-verification] this run: suites=${suites.length} tests=${totals.tests} passed=${passed} failed=${bad} skipped=${totals.skipped}`);
    if (committed === null) console.error("[emit-verification] the committed copy does not exist");
    process.exit(1);
  }
  console.log("[emit-verification] --check OK: committed copy matches this run");
  process.exit(0);
}

writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(`[emit-verification] wrote ${outPath}`);
console.log(`[emit-verification] suites=${suites.length} tests=${totals.tests} passed=${passed} failed=${bad} skipped=${totals.skipped}`);

if (requireGreen && bad > 0) {
  console.error(`[emit-verification] --require-green set but ${bad} failure(s)/error(s) present`);
  process.exit(1);
}

