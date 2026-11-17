import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repo = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@vibtra\/guard-contract$/, replacement: repo("packages/guard-contract/src/index.ts") },
      { find: /^@vibtra\/guard-contract\/(signing|vectors)$/, replacement: repo("packages/guard-contract/src/$1.ts") },
      { find: /^@vibtra\/guard-contract\/policy$/, replacement: repo("packages/guard-contract/src/policy/index.ts") },
      { find: /^@vibtra\/registry\//, replacement: repo("apps/registry/") },
    ],
  },
  test: {
    environment: "node",
    include: [
      "integration/registry/key-contracts.test.ts",
      "integration/registry/guard-signing-keys.test.ts",
      "integration/registry/guard-org-signing.test.ts",
      "integration/registry/guard-store.test.ts",
      "integration/registry/key-backend.test.ts",
      "integration/registry/local-signer.test.ts",
      "integration/registry/vault-seal.test.ts",
      "integration/guard-contract/signed-documents.test.ts",
      "integration/guard-contract/signing-guards.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
