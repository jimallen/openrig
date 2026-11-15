import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../test/hermetic-env.global.ts"],
    setupFiles: ["../../test/hermetic-env.setup.ts", "./test/helpers/trusted-run-root.setup.ts"],
    include: ["test/**/*.test.ts"],
    // Fails the run on a todo, an it.fails or an unlisted skip (test/never-skip-reporter.ts).
    reporters: ["default", "../../test/never-skip-reporter.ts"],
    // P6/D12-residue: many daemon suites spawn REAL child processes (stub-runner-*,
    // precompact-hook, bridge, restore-from-jsonl — 20+ files). Under fold-gate
    // contention (parallel files + fleet load) a single node spawn can take 5-10s,
    // exceeding vitest's 5s default and flaking on TIMEOUT (not on any assertion).
    // A generous ceiling makes these deterministic; fast tests still finish in ms,
    // so the only cost is a slower surfacing of a genuine hang.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
