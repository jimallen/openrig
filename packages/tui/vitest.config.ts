import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../test/hermetic-env.global.ts"],
    setupFiles: ["../../test/hermetic-env.setup.ts"],
    include: ["test/**/*.test.ts"],
    // Fails the run on a todo, an it.fails or an unlisted skip (test/never-skip-reporter.ts).
    reporters: ["default", "../../test/never-skip-reporter.ts"],
  },
});
