import { defineConfig, devices } from "@playwright/test";
import { ADMIN_STATE, FIXTURE_PORT, FIXTURE_URL, REGISTRY_DATA_DIR, REGISTRY_URL, registryEnv } from "./e2e/console/support/env.ts";

const FIXTURE_CONFIG = "e2e/console/fixtures/ui/vite.config.ts";

export default defineConfig({
  testDir: "./e2e/console",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/console/support/global-setup.ts",
  use: {
    baseURL: REGISTRY_URL,
    storageState: ADMIN_STATE,
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      name: "registry",
      command: [
        "env NODE_ENV=production corepack pnpm --filter @vibtra/guard-console build",
        `rm -rf "${REGISTRY_DATA_DIR}"`,
        `mkdir -p "${REGISTRY_DATA_DIR}"`,
        "env -u DATABASE_URL corepack pnpm --filter @vibtra/registry start",
      ].join(" && "),
      env: registryEnv(REGISTRY_DATA_DIR),
      url: `${REGISTRY_URL}/healthz`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "ui-fixture",
      command: `corepack pnpm exec vite build --config ${FIXTURE_CONFIG} && corepack pnpm exec vite preview --config ${FIXTURE_CONFIG} --host 127.0.0.1 --port ${FIXTURE_PORT} --strictPort`,
      url: FIXTURE_URL,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
