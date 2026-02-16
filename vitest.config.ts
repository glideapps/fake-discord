import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/worker/tests/**/*.test.ts"],
    testTimeout: 15000,
    globalSetup: "./vitest.globalSetup.ts",
  },
});
