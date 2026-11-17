import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    root: import.meta.dirname,
    include: ["sealer-mutant.fixture.ts"],
    testTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
