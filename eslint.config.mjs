import { browser, colourFences, comments, disabledAtImport, inlineDisableGuard, reactHooksFor, typescript, vendored } from "./tools/eslint/index.mjs";

export default [
  {
    name: "vibtra/ignores",
    ignores: [
      "**/dist/",
      "**/out/",
      "**/build/",
      "**/target/",
      "**/coverage/",
      "**/test-results/",
      "**/playwright-report/",
      "tests/e2e/console/.fixture-dist/",
      "**/DerivedData/",
      "infra/cdk.out/",
      "infra/*.cdk.staging/",
      "apps/registry/data/",
      "**/*.generated.*",
      "apps/landing/src/marks/index.js",
      "tools/eslint/vendor/",
    ],
  },
  ...vendored,
  browser(["apps/landing/src/**/*.js", "apps/guard-console/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"]),
  typescript,
  reactHooksFor(["apps/guard-console/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"]),
  ...colourFences({
    scripts: ["apps/guard-console/src/**/*.{ts,tsx}"],
    styles: ["apps/guard-console/src/**/*.css"],
    tokens: { files: ["apps/guard-console/src/index.css"], prefix: "--g-" },
  }),
  ...disabledAtImport,
  {
    name: "vibtra/playwright-fixtures",
    files: ["tests/e2e/**/support/**"],
    rules: { "no-empty-pattern": "off" },
  },
  {
    name: "vibtra/ee-tests-vitest",
    files: ["tests/integration/ee/**"],
    rules: { "n/no-extraneous-import": ["error", { allowModules: ["vitest"] }] },
  },
  comments,
  inlineDisableGuard,
];
