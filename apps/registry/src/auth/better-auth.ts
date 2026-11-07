import type pg from "pg";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins/organization";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { CLI_CLIENT_ID, CLI_DEVICE_EXPIRES_IN, CLI_DEVICE_INTERVAL, cliUserCode } from "../cli/device-options.js";
import { toolGateJwtPlugin, toolGateOAuthProvider } from "../issuer/provider.js";
import { boundDomains, registrySso, ssoAdminOnly } from "./sso.js";
import { ssoSecretSealing } from "./sso-secret.js";
import type { VaultSealer } from "../vault/seal.js";
import { registryTeamOptions, teamsConsoleOnly } from "./teams.js";
import { APIError } from "better-auth/api";
import { VibtraError, type VibtraErrorCode } from "../errors.js";
import { CONSOLE_DEV_ORIGINS, CONSOLE_LOGIN_PATH } from "@vibtra/console-api";
import { isAtLimit, planFor, userLimitFor } from "../config.js";
import { requireWritableOrg } from "../tenancy/billing-status.js";
import type { RegistrySession, SessionResolver } from "./session.js";
import { assertTestAuthIsPermitted } from "./test-auth.js";
import { applyOrgPlan, freeMemberLimit, planOrgForSignIn, type ClaimContext } from "../tenancy/claim.js";
import type { AuthDbAdapter, MemberDirectory } from "../tenancy/members.js";
import type { TenancyStore } from "../tenancy/store.js";

export const SESSION_EXPIRES_IN_SECONDS = 12 * 60 * 60;

export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

export const SESSION_COOKIE_NAME = "better-auth.session_token";

export interface RegistryAuthOptions {
  baseUrl: string;
  secret: string;
  gateSigningSecret: string;
  sealer?: VaultSealer | undefined;
  pool?: pg.Pool;
  google: { clientId: string; clientSecret: string };
  oidc?: { issuer: string };
  orgs: Pick<TenancyStore, "getOrg" | "createOrg" | "findOrgByDomain">;
  members: MemberDirectory;
  secureCookies: boolean;
  testAuth?: boolean;
  extraTrustedOrigins?: string[];
  overflowSeats?: boolean;
  noPeopleLimit?: boolean;
  singleOrg?: { orgExists: () => Promise<boolean> };
  waitlist?: (org: { domain?: string }) => Promise<boolean>;
  ownerEmail?: string;
  registration?: {
    mode: "allowlist";
    operatorDomain?: string;
    contactEmail?: string;
    isAllowed: (email: string) => Promise<boolean>;
  };
}

export type RegistryAuth = ReturnType<typeof createRegistryAuth>;

export const OIDC_PROVIDER_ID = "oidc";

export const oidcDiscoveryUrl = (issuer: string): string => `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

const emptyMemoryDb = (): Record<string, unknown[]> => ({
  user: [],
  session: [],
  account: [],
  verification: [],
  organization: [],
  member: [],
  invitation: [],
  team: [],
  teamMember: [],
  jwks: [],
  oauthClient: [],
  oauthResource: [],
  oauthClientResource: [],
  oauthRefreshToken: [],
  oauthAccessToken: [],
  oauthConsent: [],
  oauthClientAssertion: [],
  ssoProvider: [],
  deviceCode: [],
});

const REFUSAL_STATUS: Partial<Record<VibtraErrorCode, "FORBIDDEN" | "BAD_REQUEST">> = {
  REGISTRY_LIMIT_EXCEEDED: "FORBIDDEN",
  VALIDATION: "BAD_REQUEST",
};

const asApiError = (e: unknown): never => {
  const ve = e instanceof VibtraError ? e : undefined;
  if (ve === undefined) throw e;
  const status = REFUSAL_STATUS[ve.code];
  if (status === undefined) throw ve;
  throw new APIError(status, {
    message: ve.message,
    code: ve.code,
  });
};

const claimRefusal = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    return asApiError(e);
  }
};

const ADMINS_NAMED = 3;

const refuseIfOrgIsFull = async (ctx: ClaimContext, orgId: string, email: string): Promise<void> => {
  const org = await ctx.orgs.getOrg(orgId);
  if (org === undefined) return;
  requireWritableOrg(org, `adding ${email} to ${org.name}`);
  if (ctx.noPeopleLimit === true) return;
  const limit = userLimitFor(org);
  const count = await ctx.members.countMembers(orgId);
  if (!isAtLimit(count, limit)) return;
  if (ctx.overflowSeats === true && !planFor(org.plan).limits.sessionHoursHardCap) return;
  if (planFor(org.plan).limits.sessionHoursHardCap && org.userLimit === undefined) throw freeMemberLimit(org.name, email, count, limit);
  const admins = (await ctx.members.listAdmins(orgId)).map((a) => a.email);
  const named = admins.slice(0, ADMINS_NAMED).join(", ");
  const whoToAsk =
    admins.length === 0
      ? "an administrator of that org"
      : `${named}${admins.length > ADMINS_NAMED ? ` and ${admins.length - ADMINS_NAMED} other admin${admins.length - ADMINS_NAMED === 1 ? "" : "s"}` : ""}`;
  throw new VibtraError({
    code: "REGISTRY_LIMIT_EXCEEDED",
    message:
      `${org.name} is full: it already has ${count} of the ${limit} people ` +
      `${org.userLimit === undefined ? `its ${planFor(org.plan).name} plan allows` : "its own user limit allows"}, ` +
      `so ${email} was not added. ` +
      `Ask ${whoToAsk} to request a larger plan from the console's Billing page, or to raise its user limit.`,
    detail:
      `admission refused for ${email} into org ${org.orgId} (${org.name}): userLimit ${limit} ` +
      `(plan ${planFor(org.plan).id}${org.userLimit === undefined ? "" : ", per-org override"}), current members ${count}. ` +
      "Nothing was written: no member row was created and the org is unchanged — an invitation refused here is still pending.",
  });
};

const NO_PLUGIN_MEMBERSHIP_CEILING = Number.MAX_SAFE_INTEGER;

const PASSWORD_SIGN_UP_PATH = "/sign-up/email";

const isPasswordSignUp = (ctx: { path?: string } | null | undefined): boolean =>
  ctx?.path === PASSWORD_SIGN_UP_PATH;

export const createRegistryAuth = (options: RegistryAuthOptions) => {
  if (options.testAuth === true) assertTestAuthIsPermitted({ ...process.env, REGISTRY_TEST_AUTH: "1" });

  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  let instance: { $context: Promise<{ adapter: unknown }> } | undefined;
  const adapterOf = async (): Promise<AuthDbAdapter> => {
    if (instance === undefined) throw new Error("the registry's auth instance was used before it was constructed");
    const ctx = await instance.$context;
    return ctx.adapter as unknown as AuthDbAdapter;
  };
  const members = options.members;
  const ssoDomains = async (domain: string): Promise<string | undefined> => {
    const wanted = domain.trim().toLowerCase();
    if (wanted === "") return undefined;
    let rows: Array<{ domain?: unknown; organizationId?: unknown }>;
    try {
      rows = await (await adapterOf()).findMany<{ domain?: unknown; organizationId?: unknown }>({
        model: "ssoProvider",
      });
    } catch {
      return undefined;
    }
    for (const row of rows) {
      if (typeof row.domain !== "string" || typeof row.organizationId !== "string") continue;
      if (boundDomains(row.domain).includes(wanted)) return row.organizationId;
    }
    return undefined;
  };
  const pendingInvitation = async (email: string): Promise<boolean> => {
    const wanted = email.trim().toLowerCase();
    if (wanted === "") return false;
    let rows: Array<{ email?: unknown; status?: unknown }>;
    try {
      rows = await (await adapterOf()).findMany<{ email?: unknown; status?: unknown }>({
        model: "invitation",
        where: [{ field: "email", value: wanted }],
      });
    } catch {
      return false;
    }
    return rows.some(
      (row) => row.status === "pending" && String(row.email ?? "").trim().toLowerCase() === wanted,
    );
  };

  let joinGate: ((join: { orgId: string; email: string }) => Promise<void>) | undefined;

  const claimCtx: ClaimContext = {
    orgs: options.orgs,
    members,
    ssoDomains,
    pendingInvitation,
    ...(options.testAuth === true
      ? {
          beforeJoinWrite: async (join: { orgId: string; email: string }): Promise<void> => {
            await joinGate?.(join);
          },
        }
      : {}),
    ...(options.overflowSeats === true ? { overflowSeats: true } : {}),
    ...(options.noPeopleLimit === true ? { noPeopleLimit: true } : {}),
    ...(options.singleOrg === undefined ? {} : { singleOrg: options.singleOrg }),
    ...(options.registration === undefined ? {} : { registration: options.registration }),
    ...(options.ownerEmail === undefined ? {} : { ownerEmail: options.ownerEmail }),
    ...(options.waitlist === undefined ? {} : { waitlist: options.waitlist }),
  };

  const pendingPlans = new Map<string, Awaited<ReturnType<typeof planOrgForSignIn>>>();

  const ssoSecrets = ssoSecretSealing({ sealer: options.sealer });

  const auth = betterAuth({
    appName: "vibtra-registry",
    baseURL: baseUrl,
    secret: options.secret,
    database: options.pool === undefined ? memoryAdapter(emptyMemoryDb()) : options.pool,
    telemetry: { enabled: false },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    advanced: {
      useSecureCookies: options.secureCookies,
      cookies: {
        session_token: { attributes: { sameSite: "lax", httpOnly: true } },
      },
      disableOriginCheck: false,
    },
    user: {
      additionalFields: {
        hostedDomain: { type: "string", required: false, input: false },
        closedAt: { type: "string", required: false, input: false },
      },
    },
    socialProviders: options.oidc !== undefined ? {} : {
      google: {
        clientId: options.google.clientId,
        clientSecret: options.google.clientSecret,
        mapProfileToUser: (profile) => ({
          ...(typeof profile.hd === "string" && profile.hd !== "" ? { hostedDomain: profile.hd } : {}),
        }),
      },
    },
    emailAndPassword: { enabled: options.testAuth === true },
    trustedOrigins: [baseUrl, ...(options.extraTrustedOrigins ?? [])],
    onAPIError: {
      errorURL: `${baseUrl}${CONSOLE_LOGIN_PATH}`,
    },
    plugins: [
      ...(options.oidc === undefined
        ? []
        : [
            genericOAuth({
              config: [
                {
                  providerId: OIDC_PROVIDER_ID,
                  discoveryUrl: oidcDiscoveryUrl(options.oidc.issuer),
                  clientId: options.google.clientId,
                  clientSecret: options.google.clientSecret,
                  scopes: ["openid", "email", "profile"],
                  pkce: true,
                  requireIdTokenVerification: true,
                },
              ],
            }),
          ]),
      organization({
        allowUserToCreateOrganization: false,
        ...registryTeamOptions,
        membershipLimit: () => NO_PLUGIN_MEMBERSHIP_CEILING,
        organizationHooks: {
          ...registryTeamOptions.organizationHooks,
          beforeAcceptInvitation: async ({ organization: org, user }) => {
            await claimRefusal(() => refuseIfOrgIsFull(claimCtx, String(org.id), String(user.email ?? "")));
          },
          beforeAddMember: async ({ organization: org, user }) => {
            await claimRefusal(() => refuseIfOrgIsFull(claimCtx, String(org.id), String(user.email ?? "")));
          },
        },
      }),
      toolGateJwtPlugin(baseUrl, options.gateSigningSecret),
      toolGateOAuthProvider(baseUrl),
      registrySso(),
      ssoAdminOnly(),
      ssoSecrets,
      teamsConsoleOnly(),
      deviceAuthorization({
        expiresIn: CLI_DEVICE_EXPIRES_IN,
        interval: CLI_DEVICE_INTERVAL,
        userCodeLength: 8,
        generateUserCode: cliUserCode,
        validateClient: (clientId: string) => clientId === CLI_CLIENT_ID,
        verificationUri: `${baseUrl}/device`,
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const email = String(user.email ?? "");
            const hostedDomain = typeof user.hostedDomain === "string" ? user.hostedDomain : undefined;
            const emailVerified =
              options.testAuth === true && isPasswordSignUp(ctx) ? true : user.emailVerified === true;
            const plan = await claimRefusal(() =>
              planOrgForSignIn(claimCtx, {
                email,
                emailVerified,
                ...(hostedDomain !== undefined ? { hostedDomain } : {}),
              }),
            );
            pendingPlans.set(email, plan);
            return { data: { ...user, emailVerified } };
          },
          after: async (user) => {
            const email = String(user.email ?? "");
            const plan = pendingPlans.get(email);
            pendingPlans.delete(email);
            if (plan === undefined) return;
            if (plan.kind === "none") return;
            await claimRefusal(() => applyOrgPlan(claimCtx, plan, String(user.id), email));
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const closedAt = await members.closedAtOf(String(session.userId));
            if (closedAt !== undefined) {
              return asApiError(
                new VibtraError({
                  code: "VALIDATION",
                  message:
                    "This account was closed and cannot sign in. " +
                    "If you need access again, ask an owner or admin of your organisation to invite you.",
                  detail: `user ${String(session.userId)} carries closedAt ${closedAt} (migration 0021)`,
                }),
              );
            }
            const preferred = await members.lastActiveOrgOf(String(session.userId));
            const membership = await members.membershipOf(String(session.userId), preferred);
            if (membership === undefined) return;
            return { data: { ...session, activeOrganizationId: membership.orgId } };
          },
        },
      },
    },
  });
  instance = auth;

  const resolveSession: SessionResolver = async (headers): Promise<RegistrySession | undefined> => {
    const result = await auth.api.getSession({ headers });
    if (result === null || result === undefined) return undefined;
    const active = (result.session as { activeOrganizationId?: unknown } | undefined)?.activeOrganizationId;
    const membership = await members.membershipOf(
      result.user.id,
      typeof active === "string" && active !== "" ? active : undefined,
    );
    if (membership === undefined) return undefined;
    const image = result.user.image;
    return {
      userId: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified === true,
      ...(typeof image === "string" && image !== "" ? { image } : {}),
      orgId: membership.orgId,
      role: membership.role,
      ...(typeof result.session?.id === "string" && result.session.id !== "" ? { sessionId: result.session.id } : {}),
    };
  };

  return {
    auth,
    resolveSession,
    adapter: adapterOf,
    storedAdapter: async (): Promise<ReturnType<typeof ssoSecrets.storedAdapter>> => {
      await adapterOf();
      return ssoSecrets.storedAdapter();
    },
    members,
    setJoinGate: (gate: ((join: { orgId: string; email: string }) => Promise<void>) | undefined): void => {
      if (options.testAuth !== true) {
        throw new Error("setJoinGate is a test seam: this registry was not built with REGISTRY_TEST_AUTH=1");
      }
      joinGate = gate;
    },
    sessionCookieName: SESSION_COOKIE_NAME,
  };
};

const loopbackTwin = (baseUrl: string): string[] => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "http:") return [];
  const twinHost = url.hostname === "localhost" ? "127.0.0.1" : url.hostname === "127.0.0.1" ? "localhost" : undefined;
  if (twinHost === undefined) return [];
  return [`http://${twinHost}${url.port === "" ? "" : `:${url.port}`}`];
};

export const devTrustedOrigins = (baseUrl: string): string[] =>
  baseUrl.startsWith("http://") ? [...new Set([...CONSOLE_DEV_ORIGINS, ...loopbackTwin(baseUrl)])] : [];
