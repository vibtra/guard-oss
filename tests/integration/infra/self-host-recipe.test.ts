import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { postgresMissing } from "../registry/server-options.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY = path.join(REPO, "apps", "registry");
const ENTRYPOINT = path.join(REGISTRY, "docker-entrypoint.sh");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
const SECRET_NAMES = ["REGISTRY_SESSION_SECRET", "REGISTRY_GATE_SIGNING_SECRET", "VIBTRA_VAULT_KEY"] as const;

const serviceBlock = (compose: string, name: string): string => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe("the self-host Compose recipe", () => {
  const compose = read("apps/registry/docker-compose.yml");
  const example = read("apps/registry/self-host.env.example");
  const guide = read("docs/self-host.md");
  const guard = serviceBlock(compose, "guard");
  const postgres = serviceBlock(compose, "postgres");

  it("publishes only Guard, on loopback by default, and never Postgres", () => {
    expect(guard).toContain('ports: ["${GUARD_BIND_ADDRESS:-127.0.0.1}:${GUARD_PORT:-4700}:4700"]');
    expect(postgres).not.toMatch(/\bports:/);
    expect(compose.match(/\bports:/g)).toHaveLength(1);
  });

  it("refuses to start without the database password, the server URL and the OAuth client", () => {
    for (const name of ["GUARD_DB_PASSWORD", "REGISTRY_BASE_URL", "REGISTRY_OIDC_CLIENT_ID", "REGISTRY_OIDC_CLIENT_SECRET"]) {
      expect(compose, name).toMatch(new RegExp(`\\$\\{${name}:\\?[^}]+\\}`));
    }
  });

  it("generates the three server secrets in the data volume unless the operator supplies all three", () => {
    for (const name of SECRET_NAMES) expect(guard, name).toContain(`${name}: \${${name}:-}`);
    expect(guard).toContain('volumes: ["guard-data:/data"]');
    expect(postgres).toContain('volumes: ["guard-postgres:/var/lib/postgresql/data"]');
  });

  it("passes every documented input through, and the guide names each one", () => {
    const keys = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] ?? "");
    expect(keys).toContain("REGISTRY_OWNER_EMAIL");
    for (const key of keys) {
      expect(compose, `${key} reaches the containers`).toContain(`\${${key}`);
      expect(guide, `${key} is documented`).toContain(key);
    }
    const passed = [...guard.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1] ?? "");
    for (const key of passed.filter((k) => k !== "DATABASE_URL")) expect(guide, `${key} is documented`).toContain(key);
  });

  it("pins base images by digest and ships no secrets and no ee/ in the image", () => {
    const dockerfile = read("apps/registry/Dockerfile");
    expect(postgres).toMatch(/image: postgres:[0-9.]+-alpine@sha256:[0-9a-f]{64}/);
    for (const from of dockerfile.match(/^FROM .+$/gm) ?? []) expect(from).toMatch(/@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("rm -rf ee");
    expect(dockerfile).toContain("test -f apps/guard-console/dist/index.html");
    expect(dockerfile).toContain("test -f packages/guard-contract/src/index.ts");
    for (const line of dockerfile.match(/^ENV .+$/gm) ?? []) expect(line).not.toMatch(/SECRET|VAULT|PASSWORD|CLIENT/);
    expect(dockerfile).toContain("ENTRYPOINT [\"guard-entrypoint\"]");
  });
});

const run = (env: Record<string, string>, command: string[] = ["sh", "-c", 'printf "%s\\n" "$REGISTRY_SESSION_SECRET" "$REGISTRY_GATE_SIGNING_SECRET" "$VIBTRA_VAULT_KEY"']) =>
  spawnSync("sh", [ENTRYPOINT, ...command], { cwd: REGISTRY, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, timeout: 30_000 });

describe("the image entrypoint", () => {
  let data: string;
  beforeAll(() => {
    data = mkdtempSync(path.join(os.tmpdir(), "guard-entrypoint-"));
  });
  afterAll(() => rmSync(data, { recursive: true, force: true }));

  it("refuses a public http:// server URL and accepts https:// or loopback", () => {
    const refused = run({ REGISTRY_BASE_URL: "http://guard.example.com", VIBTRA_REGISTRY_DATA_DIR: data });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("REGISTRY_BASE_URL must start with https://");
    expect(run({ VIBTRA_REGISTRY_DATA_DIR: data }).stderr).toContain("Set REGISTRY_BASE_URL");
    const supplied = Object.fromEntries(SECRET_NAMES.map((n) => [n, `${n.toLowerCase()}-supplied`]));
    for (const base of ["https://guard.example.com", "http://localhost:4700"]) {
      const ok = run({ REGISTRY_BASE_URL: base, VIBTRA_REGISTRY_DATA_DIR: data, ...supplied });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout.trim().split("\n")).toEqual(SECRET_NAMES.map((n) => `${n.toLowerCase()}-supplied`));
    }
    expect(() => statSync(path.join(data, "secrets.env"))).toThrow();
  });

  it("refuses a data directory it cannot write", () => {
    const missing = run({ REGISTRY_BASE_URL: "https://guard.example.com", VIBTRA_REGISTRY_DATA_DIR: path.join(data, "absent") });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("is not a writable directory");
  });

  it("refuses to mint secrets when it cannot check the database", () => {
    const blind = run({ REGISTRY_BASE_URL: "https://guard.example.com", VIBTRA_REGISTRY_DATA_DIR: data, DATABASE_URL: "postgres://guard:x@127.0.0.1:1/none" });
    expect(blind.status).toBe(1);
    expect(blind.stderr).toContain("Could not check the database before generating secrets");
    expect(() => statSync(path.join(data, "secrets.env"))).toThrow();
  });

  const shared = process.env.VIBTRA_TEST_DATABASE_URL ?? "";
  describe.skipIf(postgresMissing())("against Postgres (VIBTRA_TEST_DATABASE_URL)", () => {
    const name = `guard_entrypoint_${randomBytes(5).toString("hex")}`;
    const url = new URL(shared === "" ? "postgres://unset.invalid/unset" : shared);
    url.pathname = `/${name}`;
    const admin = async (sql: string, target = shared): Promise<void> => {
      const stores = createPostgresRegistryStores(target);
      try {
        await stores.pool.query(sql);
      } finally {
        await stores.close();
      }
    };
    beforeAll(() => admin(`CREATE DATABASE ${name}`));
    afterAll(() => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));

    it("generates the secrets once on an empty database, keeps them across restarts, and refuses to re-mint them for an existing one", async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "guard-entrypoint-db-"));
      try {
        const env = { REGISTRY_BASE_URL: "https://guard.example.com", VIBTRA_REGISTRY_DATA_DIR: dir, DATABASE_URL: url.href };
        const first = run(env);
        expect(first.status, first.stderr).toBe(0);
        expect(first.stderr).toContain("generated server secrets");
        const values = first.stdout.trim().split("\n");
        expect(values).toHaveLength(3);
        for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
        expect(new Set(values).size).toBe(3);
        const file = path.join(dir, "secrets.env");
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(readFileSync(file, "utf8")).toContain(`VIBTRA_VAULT_KEY=${values[2]}`);

        const again = run(env);
        expect(again.status, again.stderr).toBe(0);
        expect(again.stderr).not.toContain("generated");
        expect(again.stdout.trim().split("\n")).toEqual(values);

        const override = run({ ...env, REGISTRY_SESSION_SECRET: "operator-supplied-session-secret" });
        expect(override.stdout.trim().split("\n")).toEqual(["operator-supplied-session-secret", values[1], values[2]]);

        await admin("CREATE TABLE registry_migrations (name text primary key); INSERT INTO registry_migrations VALUES ('0001')", url.href);
        unlinkSync(file);
        const refused = run(env);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("The database already holds Guard data, but");
        expect(() => statSync(file)).toThrow();

        writeFileSync(file, "REGISTRY_SESSION_SECRET=a\nREGISTRY_GATE_SIGNING_SECRET=b\n", { mode: 0o644 });
        const partial = run(env);
        expect(partial.status).toBe(1);
        expect(partial.stderr).toContain("has no VIBTRA_VAULT_KEY");
        expect(statSync(file).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
