// Opt-in runs: measurements, generators and child-run fixtures that are not checks of the suite. They live in
// test/**/*.opt-in.ts, which vitest.config.ts does not collect, so `npm test` never lists them as skipped tests.
// This config is the suite's own (same setup, timeouts and hermetic env) and collects those files as well;
// run one by naming it:
//   npx vitest run -c vitest.opt-in.config.ts test/<name>.opt-in.ts
import { defineConfig } from "vitest/config";
import suite from "./vitest.config";

export default defineConfig({
  ...suite,
  test: { ...suite.test, include: ["test/**/*.test.ts", "test/**/*.opt-in.ts"] },
});
