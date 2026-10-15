import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    // Leave CPU for launcher subprocesses while sibling files import Effect.
    maxWorkers: 3,
    include: ["test/**/*.test.ts"],
  },
});
