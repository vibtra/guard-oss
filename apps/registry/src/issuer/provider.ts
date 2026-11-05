import crypto from "node:crypto";
import { jwt, type Jwk } from "better-auth/plugins/jwt";
import { symmetricDecrypt } from "better-auth/crypto";
import { isGateSealed, openGateSigningKey, sealGateSigningKey } from "./jwks-secret.js";
import { CONSOLE_LOGIN_PATH } from "@vibtra/console-api";
import { oauthProvider } from "@better-auth/oauth-provider";
import { hashToolClientSecret, verifyToolClientSecret } from "../tools/secret.js";
import { AUTH_BASE_PATH } from "../auth/fastify.js";

const mcpResourceIdentifier = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/mcp`;

const hashOpaqueToken = (token: string): string => crypto.createHash("sha256").update(token, "utf8").digest("hex");

const blockedAuthPrefixes = [`${AUTH_BASE_PATH}/oauth2/`, `${AUTH_BASE_PATH}/admin/oauth2/`];
const blockedAuthPaths = [
  `${AUTH_BASE_PATH}/.well-known/openid-configuration`,
  `${AUTH_BASE_PATH}/.well-known/oauth-authorization-server`,
];

export const isBlockedIssuerPath = (pathname: string): boolean =>
  blockedAuthPrefixes.some((prefix) => pathname.startsWith(prefix)) || blockedAuthPaths.includes(pathname);

export const ID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export const AUTHORIZATION_CODE_TTL_SECONDS = 600;

export const TOOL_GATE_SCOPES = ["openid", "email"] as const;

interface JwksAdapterContext {
  context: {
    adapter: {
      findMany: <T>(args: { model: string }) => Promise<T[]>;
      create: <T>(args: { model: string; data: Record<string, unknown> }) => Promise<T>;
      update: <T>(args: { model: string; where: Array<{ field: string; value: string }>; update: Record<string, unknown> }) => Promise<T | null>;
    };
  };
}

const upgradeStoredJwk =
  (ctx: JwksAdapterContext) =>
  (id: string, sealed: string): void => {
    void ctx.context.adapter
      .update({ model: "jwks", where: [{ field: "id", value: id }], update: { privateKey: sealed } })
      .catch(() => undefined);
  };

const openStoredJwk = async (
  row: Jwk,
  gateSigningSecret: string,
  upgrade: (id: string, sealed: string) => void,
): Promise<Jwk> => {
  const stored = row.privateKey;
  if (typeof stored !== "string" || stored === "") return row;

  if (isGateSealed(stored)) {
    const opened = { ...row } as Jwk;
    Object.defineProperty(opened, "privateKey", {
      get: () => openGateSigningKey(gateSigningSecret, stored),
      enumerable: false,
      configurable: true,
    });
    return opened;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return row;
  }
  if (typeof parsed === "object" && parsed !== null && "kty" in (parsed as Record<string, unknown>)) {
    upgrade(row.id, sealGateSigningKey(gateSigningSecret, stored));
    return row;
  }

  if (typeof parsed !== "string") return row;
  try {
    const opened = await symmetricDecrypt({ key: gateSigningSecret, data: parsed });
    upgrade(row.id, sealGateSigningKey(gateSigningSecret, opened));
    return { ...row, privateKey: opened };
  } catch {
    return row;
  }
};

export const toolGateJwtPlugin = (
  baseUrl: string,
  gateSigningSecret: string,
) =>
  jwt({
    jwks: {
      keyPairConfig: { alg: "ES256" },
      disablePrivateKeyEncryption: true,
    },
    adapter: {
      getJwks: async (ctx) => {
        const rows = await ctx.context.adapter.findMany<Jwk>({ model: "jwks" });
        const opened: Jwk[] = [];
        for (const row of rows) opened.push(await openStoredJwk(row, gateSigningSecret, upgradeStoredJwk(ctx)));
        return opened;
      },
      createJwk: async (webKey, ctx) => {
        const privateKey = webKey.privateKey;
        const created = await ctx.context.adapter.create<Jwk>({
          model: "jwks",
          data: { ...webKey, privateKey: sealGateSigningKey(gateSigningSecret, privateKey) },
        });
        return { ...created, privateKey };
      },
    },
    jwt: { issuer: baseUrl.replace(/\/+$/, "") },
    disableSettingJwtHeader: true,
  });

export const toolGateOAuthProvider = (baseUrl: string) =>
  oauthProvider({
    loginPage: CONSOLE_LOGIN_PATH,
    consentPage: CONSOLE_LOGIN_PATH,
    scopes: [...TOOL_GATE_SCOPES],
    resources: [mcpResourceIdentifier(baseUrl)],
    resourceSeedMode: "insertOnly",
    enforcePerClientResources: false,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    storeTokens: { hash: (token: string) => hashOpaqueToken(token) },
    grantTypes: ["authorization_code", "client_credentials"],
    idTokenExpiresIn: ID_TOKEN_TTL_SECONDS,
    accessTokenExpiresIn: ID_TOKEN_TTL_SECONDS,
    codeExpiresIn: AUTHORIZATION_CODE_TTL_SECONDS,
    storeClientSecret: {
      hash: (secret: string) => hashToolClientSecret(secret),
      verify: (secret: string, storedHash: string) => verifyToolClientSecret(secret, storedHash),
    },
    customIdTokenClaims: ({ user, scopes }) =>
      scopes.includes("email")
        ? { email: user.email, email_verified: user.emailVerified === true }
        : {},
  });
