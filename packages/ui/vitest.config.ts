import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Fails the run on a todo, an it.fails or an unlisted skip (test/never-skip-reporter.ts).
    reporters: ["default", "../../test/never-skip-reporter.ts"],
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    css: true,
  },
});
