import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY_PORT = 4791;
export const FIXTURE_PORT = 4792;
export const REGISTRY_URL = `http://127.0.0.1:${REGISTRY_PORT}`;
export const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

export const CONSOLE_E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = path.join(CONSOLE_E2E_DIR, ".state");
export const ADMIN_STATE = path.join(STATE_DIR, "admin.json");
export const MEMBER_STATE = path.join(STATE_DIR, "member.json");
export const SEED_FILE = path.join(STATE_DIR, "seed.json");
export const REGISTRY_DATA_DIR = path.join(os.tmpdir(), "vibtra-guard-console-e2e");

export const ORG_DOMAIN = "fernwood.example";
export const VAULT_KEY = "a".repeat(64);
export const SESSION_SECRET = "e2e-console-session-secret-not-a-real-secret-0123456789";

export const registryEnv = (dataDir: string): Record<string, string> => ({
  NODE_ENV: "test",
  REGISTRY_MODE: "hosted",
  REGISTRY_TEST_AUTH: "1",
  HOST: "127.0.0.1",
  PORT: String(REGISTRY_PORT),
  REGISTRY_BASE_URL: REGISTRY_URL,
  REGISTRY_SESSION_SECRET: SESSION_SECRET,
  REGISTRY_GATE_SIGNING_SECRET: `${SESSION_SECRET}-gate`,
  REGISTRY_OIDC_CLIENT_ID: "e2e-console-client.apps.example",
  REGISTRY_OIDC_CLIENT_SECRET: "e2e-console-client-secret-not-real",
  VIBTRA_VAULT_KEY: VAULT_KEY,
  VIBTRA_REGISTRY_DATA_DIR: dataDir,
});
