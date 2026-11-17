import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRegistryConfig, OTHER_VIBTRA_VARIABLES, REGISTRY_VIBTRA_VARIABLES } from "@vibtra/registry/src/config.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const hosted: NodeJS.ProcessEnv = {
  REGISTRY_MODE: "hosted",
  REGISTRY_BASE_URL: "http://localhost:4700",
  REGISTRY_SESSION_SECRET: "guard-tests-session-secret-0123456789abcdef0123",
  REGISTRY_OIDC_CLIENT_ID: "guard-self-host",
  REGISTRY_OIDC_CLIENT_SECRET: "self-host-client-secret-not-real",
  NODE_ENV: "test",
};

const refusal = (env: NodeJS.ProcessEnv): { message: string; detail: string } => {
  try {
    loadRegistryConfig(env);
  } catch (error) {
    return { message: (error as Error).message, detail: String((error as { detail?: unknown }).detail ?? "") };
  }
  throw new Error(`loadRegistryConfig accepted ${Object.keys(env).join(", ")}`);
};

describe("the registry refuses VIBTRA_* variables it does not know or would ignore", () => {
  it("knows every VIBTRA_* variable the registry source reads", () => {
    const read = execFileSync("git", ["grep", "-ohE", String.raw`env(\.|\[")VIBTRA_[A-Z0-9_]+`, "--", "apps/registry/src"], { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((hit) => hit.replace(/^env(\.|\[")/, ""));
    expect([...new Set(read)].filter((name) => !(REGISTRY_VIBTRA_VARIABLES as readonly string[]).includes(name)).sort()).toEqual([]);
  });

  it("boots with every known variable set, in hosted mode", () => {
    const env = { ...hosted, ...Object.fromEntries([...REGISTRY_VIBTRA_VARIABLES, ...Object.keys(OTHER_VIBTRA_VARIABLES)].map((name) => [name, ""])) };
    expect(loadRegistryConfig(env).mode).toBe("hosted");
  });

  it("refuses an unknown VIBTRA_* name, suggests the near one and echoes no value", () => {
    const { message, detail } = refusal({ ...hosted, VIBTRA_VAULT_KEYS: "super-secret-value", VIBTRA_NOPE: "1" });
    expect(message).toBe("Unknown VIBTRA_* variable: VIBTRA_NOPE, VIBTRA_VAULT_KEYS");
    expect(detail).toContain("VIBTRA_VAULT_KEYS is not a setting of this registry (did you mean VIBTRA_VAULT_KEY?)");
    expect(detail).toContain("VIBTRA_NOPE is not a setting of this registry;");
    expect(detail).toContain("add it to REGISTRY_VIBTRA_VARIABLES in apps/registry/src/config.ts");
    expect(`${message} ${detail}`).not.toContain("super-secret-value");
  });

  it("refuses an unknown VIBTRA_* name in single mode too", () => {
    expect(refusal({ VIBTRA_REGISTRY_DATADIR: "/data" }).message).toBe("Unknown VIBTRA_* variable: VIBTRA_REGISTRY_DATADIR");
  });

  it("refuses the vault key and the key backend outside hosted mode, where they do nothing", () => {
    for (const name of ["VIBTRA_KEY_BACKEND", "VIBTRA_VAULT_KEY", "VIBTRA_VAULT_KEY_PREVIOUS"]) {
      const { message, detail } = refusal({ REGISTRY_MODE: "single", [name]: "a".repeat(64) });
      expect(message).toBe(`${name} is set but REGISTRY_MODE is not hosted`);
      expect(detail).toContain(`Set REGISTRY_MODE=hosted or unset ${name}.`);
    }
  });

  it("reads an empty or blank vault key as unset outside hosted mode, as the rest of the config does", () => {
    for (const name of ["VIBTRA_VAULT_KEY", "VIBTRA_VAULT_KEY_PREVIOUS"]) {
      for (const value of ["", "  "]) expect(loadRegistryConfig({ REGISTRY_MODE: "single", [name]: value }).mode, `${name}=${JSON.stringify(value)}`).toBe("single");
    }
  });

  it("refuses VIBTRA_REGISTRY_URL on a hosted registry, which never reads it, and says REGISTRY_BASE_URL is the registry's address", () => {
    const { message, detail } = refusal({ ...hosted, VIBTRA_REGISTRY_URL: "https://guard.example" });
    expect(message).toBe("VIBTRA_REGISTRY_URL is set but REGISTRY_MODE is hosted");
    expect(detail).toContain("the registry's own address is REGISTRY_BASE_URL");
    expect(detail).toContain("Unset VIBTRA_REGISTRY_URL.");
    expect(detail).not.toContain("guard.example");
    expect(loadRegistryConfig({ REGISTRY_MODE: "single", VIBTRA_REGISTRY_URL: "http://127.0.0.1:4700" }).mode).toBe("single");
  });

  it("still refuses OPENBAO_* before anything else", () => {
    expect(refusal({ ...hosted, OPENBAO_ADDR: "http://127.0.0.1:8200", VIBTRA_NOPE: "1" }).message).toBe("OpenBao support was removed; unset OPENBAO_*");
  });
});
