import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONSOLE_API_PREFIX, CSRF_COOKIE, CSRF_HEADER } from "@vibtra/console-api";
import { SESSION_COOKIE_NAME } from "@vibtra/registry/src/auth/better-auth.ts";
import { createRegistryServer, type RegistryServer, type RegistryServerOptions } from "@vibtra/registry/src/server.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { createCleanup, startOrCleanUp } from "./cleanup.ts";
import { isRecord } from "./guards.ts";

export const REGISTRY_ORIGIN = "http://registry.test.local";

export interface Person {
  readonly name: string;
  readonly email: string;
  readonly userId: string;
  readonly cookie: string;
  readonly csrf: string;
}

export interface ConsoleReply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

export type ConsoleWriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface TestRegistry {
  readonly url: string;
  readonly server: RegistryServer;
  readonly people: { readonly owner: Person; readonly admin: Person; readonly member: Person };
  join(name: string, domain?: string): Promise<Person>;
  consoleGet(person: Person, consolePath: string): Promise<ConsoleReply>;
  consoleWrite(person: Person, method: ConsoleWriteMethod, consolePath: string, body?: unknown): Promise<ConsoleReply>;
  close(): Promise<void>;
}

export interface StartRegistryOptions {
  readonly domain?: string;
  readonly configure?: (options: RegistryServerOptions) => RegistryServerOptions;
}

const runSql = async (databaseUrl: string, sql: string): Promise<void> => {
  const admin = createPostgresRegistryStores(databaseUrl);
  try {
    await admin.pool.query(sql);
  } finally {
    await admin.close();
  }
};

const replyOf = async (response: Response): Promise<ConsoleReply> => {
  const text = await response.text();
  try {
    return { status: response.status, text, body: JSON.parse(text) };
  } catch {
    return { status: response.status, text, body: undefined };
  }
};

const setCookiePair = (response: Response, name: string): string | undefined =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => pair.startsWith(`${name}=`));

const isSignedUp = (value: unknown): value is { user: { id: string } } =>
  isRecord(value) && isRecord(value.user) && typeof value.user.id === "string";

export const startRegistry = async (options: StartRegistryOptions = {}): Promise<TestRegistry> => {
  const domain = options.domain ?? "guard-tests.example";
  const cleanup = createCleanup();
  return startOrCleanUp(cleanup, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guard-registry-"));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));

    const sharedDatabaseUrl = process.env.VIBTRA_TEST_DATABASE_URL;
    let databaseUrl: string | undefined;
    if (sharedDatabaseUrl !== undefined && sharedDatabaseUrl !== "") {
      const schema = `guard_tests_${randomBytes(6).toString("hex")}`;
      await runSql(sharedDatabaseUrl, `CREATE SCHEMA ${schema}`);
      cleanup.defer(() => runSql(sharedDatabaseUrl, `DROP SCHEMA IF EXISTS ${schema} CASCADE`));
      databaseUrl = `${sharedDatabaseUrl}${sharedDatabaseUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
    }

    const serverOptions: RegistryServerOptions = {
      dataDir: root,
      landingDistDir: path.join(root, "no-landing-build"),
      guardConsoleDistDir: path.join(root, "no-guard-console-build"),
      config: {
        mode: "hosted",
        ...(databaseUrl === undefined ? {} : { databaseUrl }),
        hosted: {
          baseUrl: REGISTRY_ORIGIN,
          sessionSecret: "guard-tests-session-secret-0123456789abcdef0123",
          oidc: {
            issuer: "https://accounts.google.com",
            clientId: "guard-tests-client-id.apps.example",
            clientSecret: "guard-tests-client-secret-not-real",
          },
          testAuth: true,
          defaultConnectionLimit: 10,
          vaultKey: "a".repeat(64),
        },
      },
    };
    const server = await createRegistryServer(options.configure === undefined ? serverOptions : options.configure(serverOptions));
    cleanup.defer(() => server.app.close());
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    if (address === null || typeof address === "string") throw new Error("the registry did not listen on a TCP port");
    const url = `http://127.0.0.1:${address.port}`;

    const consoleGet = async (person: Person, consolePath: string): Promise<ConsoleReply> =>
      replyOf(await fetch(`${url}${CONSOLE_API_PREFIX}${consolePath}`, { headers: { cookie: person.cookie } }));

    const consoleWrite = async (person: Person, method: ConsoleWriteMethod, consolePath: string, body?: unknown): Promise<ConsoleReply> =>
      replyOf(
        await fetch(`${url}${CONSOLE_API_PREFIX}${consolePath}`, {
          method,
          headers: {
            cookie: person.cookie,
            origin: REGISTRY_ORIGIN,
            [CSRF_HEADER]: person.csrf,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    const join = async (name: string, personDomain: string = domain): Promise<Person> => {
      const email = `${name}@${personDomain}`;
      const signUp = await fetch(`${url}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
        body: JSON.stringify({ email, password: `vibtra-test-passphrase-${email}`, name }),
      });
      const session = setCookiePair(signUp, SESSION_COOKIE_NAME);
      const signedUp = await replyOf(signUp);
      if (!signUp.ok || session === undefined || !isSignedUp(signedUp.body)) {
        throw new Error(`sign-up for ${email} answered ${signedUp.status}: ${signedUp.text.slice(0, 300)}`);
      }
      const sessionPage = await fetch(`${url}${CONSOLE_API_PREFIX}/session`, { headers: { cookie: session } });
      const csrfPair = setCookiePair(sessionPage, CSRF_COOKIE);
      const sessionReply = await replyOf(sessionPage);
      if (sessionReply.status !== 200 || csrfPair === undefined) {
        throw new Error(`the console session for ${email} answered ${sessionReply.status}: ${sessionReply.text.slice(0, 300)}`);
      }
      return {
        name,
        email,
        userId: signedUp.body.user.id,
        cookie: `${session}; ${csrfPair}`,
        csrf: csrfPair.slice(CSRF_COOKIE.length + 1),
      };
    };

    const owner = await join("owner");
    const admin = await join("admin");
    const member = await join("member");
    const promoted = await consoleWrite(owner, "POST", `/people/${admin.userId}/role`, { role: "admin" });
    if (promoted.status !== 200) throw new Error(`promoting ${admin.email} answered ${promoted.status}: ${promoted.text.slice(0, 300)}`);

    return { url, server, people: { owner, admin, member }, join, consoleGet, consoleWrite, close: cleanup.run };
  });
};
