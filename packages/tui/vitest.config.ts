import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../../test/hermetic-env.global.ts"],
    setupFiles: ["../../test/hermetic-env.setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
