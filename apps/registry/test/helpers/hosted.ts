import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { SESSION_COOKIE_NAME } from "../../src/auth/better-auth.js";
import type { RegistryEnterprise } from "../../src/enterprise.js";
import { createRegistryServer, type RegistryServer } from "../../src/server.js";

export const SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";

export const TEST_CONSOLE_ISSUER = "https://accounts.google.com";

export const TEST_GOOGLE_CLIENT_ID = "test-google-client-id.apps.example";
export const TEST_GOOGLE_CLIENT_SECRET = "test-google-client-secret-not-real";

export const VAULT_KEY = "a".repeat(64);
export const VAULT_KEY_B = "b".repeat(64);

export const startHostedRegistry = async (
  overrides: {
    defaultConnectionLimit?: number | null;
    vaultKey?: string | null;
    openbao?: { addr: string; roleId: string; secretId: string; namespacePrefix?: string };
    dataDir?: string;
    extraTrustedOrigins?: string[];
    databaseUrl?: string;
    registration?: { mode: "open" | "allowlist"; operatorDomain?: string; contactEmail?: string };
    stripe?: { secretKey: string; prices: Record<string, string>; webhookSecret?: string; endpoint?: { host: string; port: number; protocol: "http" | "https" } };
    clock?: import("../../src/metering/clock.js").Clock;
    freeBudgetHours?: number;
    logger?: boolean | { stream: { write: (line: string) => void } };
    enterprise?: RegistryEnterprise;
  } = {},
): Promise<{ registry: RegistryServer; dataDir: string }> => {
  const dataDir = overrides.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "vibtra-registry-hosted-")));
  const vaultKey = overrides.vaultKey === null ? undefined : (overrides.vaultKey ?? VAULT_KEY);
  const registry = await createRegistryServer({
    landingDistDir: "/nonexistent/no-landing-build-here",
    dataDir,
    config: {
      mode: "hosted",
      ...(overrides.databaseUrl !== undefined ? { databaseUrl: overrides.databaseUrl } : {}),
      hosted: {
        baseUrl: "http://registry.test.local",
        ...(overrides.extraTrustedOrigins === undefined
          ? {}
          : { extraTrustedOrigins: overrides.extraTrustedOrigins }),
        sessionSecret: SESSION_SECRET,
        oidc: {
          issuer: TEST_CONSOLE_ISSUER,
          clientId: TEST_GOOGLE_CLIENT_ID,
          clientSecret: TEST_GOOGLE_CLIENT_SECRET,
        },
        testAuth: true,
        ...(overrides.defaultConnectionLimit === null
          ? {}
          : { defaultConnectionLimit: overrides.defaultConnectionLimit ?? 10 }),
        ...(vaultKey !== undefined ? { vaultKey } : {}),
        ...(overrides.stripe === undefined
          ? {}
          : {
              stripeSecretKey: overrides.stripe.secretKey,
              stripePrices: overrides.stripe.prices,
              ...(overrides.stripe.webhookSecret === undefined ? {} : { stripeWebhookSecret: overrides.stripe.webhookSecret }),
            }),
        ...(overrides.registration === undefined ? {} : { registration: overrides.registration }),
        ...(overrides.openbao === undefined
          ? {}
          : {
              openbaoAddr: overrides.openbao.addr,
              openbaoRoleId: overrides.openbao.roleId,
              openbaoSecretId: overrides.openbao.secretId,
              ...(overrides.openbao.namespacePrefix === undefined
                ? {}
                : { openbaoNamespacePrefix: overrides.openbao.namespacePrefix }),
            }),
      },
    },
    ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
    ...(overrides.stripe?.endpoint !== undefined ? { stripeEndpoint: overrides.stripe.endpoint } : {}),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    ...(overrides.freeBudgetHours !== undefined ? { freeBudgetHours: overrides.freeBudgetHours } : {}),
    ...(overrides.enterprise === undefined ? {} : { enterprise: overrides.enterprise }),
  });
  return { registry, dataDir };
};

const rawCookie = (res: LightMyRequestResponse, name: string): string | undefined => {
  const header = res.headers["set-cookie"];
  const all = header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
  const match = all.find((line) => line.startsWith(`${name}=`));
  return match?.split(";")[0]?.slice(name.length + 1);
};

export interface SignInUser {
  sub: string;
  email: string;
}

const passwordFor = (email: string): string => `vibtra-test-passphrase-${email}`;

export const signIn = async (registry: RegistryServer, user: SignInUser): Promise<string> => {
  const res = await signInRaw(registry, user);
  const name = [SESSION_COOKIE_NAME, `__Secure-${SESSION_COOKIE_NAME}`].find((n) => rawCookie(res, n) !== undefined) ?? SESSION_COOKIE_NAME;
  const session = rawCookie(res, name);
  if (res.statusCode >= 400 || session === undefined) {
    throw new Error(`sign-in did not produce a session: ${res.statusCode} ${res.body}`);
  }
  return `${name}=${session}`;
};

export const signInRaw = async (registry: RegistryServer, user: SignInUser): Promise<LightMyRequestResponse> => {
  const existing = await userIdOf(registry, user.sub);
  const url = existing === undefined ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
  return registry.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", origin: "http://registry.test.local" },
    payload: {
      email: user.email,
      password: passwordFor(user.email),
      ...(existing === undefined ? { name: user.sub } : {}),
    },
  });
};

const adapterOf = async (registry: RegistryServer) => {
  const auth = registry.auth;
  if (auth === undefined) throw new Error("this registry has no sign-in — startHostedRegistry builds one that does");
  return auth.adapter();
};

export const userIdOf = async (registry: RegistryServer, sub: string): Promise<string | undefined> => {
  const adapter = await adapterOf(registry);
  const user = await adapter.findOne<{ id: string }>({ model: "user", where: [{ field: "name", value: sub }] });
  return user === null ? undefined : user.id;
};

export const orgIdOf = async (registry: RegistryServer, sub: string): Promise<string | undefined> => {
  const userId = await userIdOf(registry, sub);
  if (userId === undefined) return undefined;
  const adapter = await adapterOf(registry);
  const member = await adapter.findOne<{ organizationId: string }>({
    model: "member",
    where: [{ field: "userId", value: userId }],
  });
  return member === null ? undefined : member.organizationId;
};
