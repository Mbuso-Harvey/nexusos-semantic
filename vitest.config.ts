import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Pin the project root. Without this, Vite walks up the directory tree
  // and picks up unrelated configs (e.g. C:\Users\Harvey\postcss.config.js
  // for a Tailwind project) when the project lives under C:\Users\Harvey\.
  root: __dirname,
  css: {
    // Vite + postcss-load-config walks up from `root` looking for a
    // postcss.config.{js,cjs,mjs,ts}. If found, it tries to load the
    // plugins. Provide an empty plugin list to short-circuit the lookup
    // (we don't use CSS in this Node-environment test suite, so there's
    // nothing to load). Without this, the walk finds C:\Users\Harvey\
    // \postcss.config.js (a Tailwind project unrelated to us).
    postcss: { plugins: [] },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // PR-8f gate robustness (2026-09-17): 30s was tight for the serialized
    // single-fork run — the first BiDi session of a suite group pays
    // Firefox's cold-boot cost, and a test that times out at 30s leaks its
    // Marionette session, which then fails every DOWNSTREAM BiDi suite's
    // beforeAll ("session create failed: 500 / Session is already started")
    // — one timeout cascaded into 6 failed files. 60s accommodates the
    // environment; no assertion is weakened.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // PR-8i T6: emit JUnit XML so the CI workflow can publish
    // test results as a build artifact. The default `default`
    // reporter is kept so the local dev experience is unchanged.
    reporters: [
      ["default"],
      ["junit", { outputFile: "test-results.junit.xml" }],
    ],
    // PR-8f gate: serialize test files. geckodriver accepts only one
    // BiDi session at a time, and the e2e file plus the convergence-trace
    // diagnostic both open a BiDi session against it. Running files in
    // parallel (the vitest default) caused the second file to fail with
    // "Session is already started". singleFork runs every file in the
    // same worker, serially. Every test still EXECUTES — none are
    // skipped, excluded, or `it.skip`-ed. This is the only configuration
    // that satisfies the "no exclusions" rule while keeping a single
    // geckodriver alive.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
