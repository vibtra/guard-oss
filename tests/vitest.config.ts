import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["integration/**/*.test.ts", "e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      allowExternal: true,
      reportsDirectory: "coverage",
      reporter: ["json", "json-summary", "text-summary"],
      include: ["**/apps/*/src/**", "**/packages/*/src/**", "**/ee/src/**", "**/infra/lib/**"],
      exclude: ["**/node_modules/**", "**/*.test.*", "**/dist/**"],
    },
  },
});
