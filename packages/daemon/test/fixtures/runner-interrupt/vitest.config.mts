// workspaces-21r: the inner vitest run that runner-interrupt-orphans.real.test.ts starts and then interrupts. Its one file is
// not a *.test.ts, so the daemon suite's own include never collects it.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.fixture.ts"],
    // The "timeout" row lets vitest's own test timeout end the hanging test; the signal rows never reach it.
    testTimeout: Number(process.env.RI_TEST_TIMEOUT_MS ?? 600_000),
    hookTimeout: 60_000,
  },
});
