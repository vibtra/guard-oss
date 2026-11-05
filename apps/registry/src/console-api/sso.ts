import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { APIError } from "better-auth/api";
import { VibtraError } from "../errors.js";
import {
  CONSOLE_API_PREFIX,
  ConsoleSsoDomainBinding,
  ConsoleSsoRegistration,
  type ConsoleSsoPage,
  type ConsoleSsoProviderRow,
  type ConsoleSsoTestResult,
} from "@vibtra/console-api";
import { requireSession, toWebHeaders, type RegistrySession } from "../auth/session.js";
import {
  boundDomains,
  discoverSsoIssuer,
  isSubDomainOf,
  ssoClaimPolicyFor,
  ssoDiscoveryFailure,
  ssoProviderIdFor,
  ssoRedirectUri,
} from "../auth/sso.js";
import type { RegistryService } from "../service.js";
import type { ConsoleApiContext } from "./routes.js";
import { requireAdmin } from "./guard.js";
import { forbidden, notFound, refuseWithStatus, sendConsole } from "./respond.js";

const PROVIDER_ID_TAKEN = /already exists/i;

export const refuseFromAuth = (reply: FastifyReply, error: unknown, fallback: string): FastifyReply => {
  if (!(error instanceof APIError)) throw error;
  const body = error.body as { message?: unknown; code?: unknown } | undefined;
  const message = typeof body?.message === "string" && body.message !== "" ? body.message : fallback;
  const status = String(error.status);
  const code = typeof body?.code === "string" ? body.code : status;
  const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400 ? error.statusCode : 500;

  if (statusCode >= 500) {
    return refuseWithStatus(
      reply,
      500,
      "INTERNAL",
      fallback,
      `Better Auth's SSO plugin failed with ${statusCode} (${status})`,
    );
  }
  if (statusCode === 404) return notFound(reply, "No such sign-in provider here", `${message} (${code})`);
  if (statusCode === 422 && PROVIDER_ID_TAKEN.test(message)) {
    return refuseWithStatus(
      reply,
      409,
      "VALIDATION",
      message,
      "A sign-in provider is already registered for this domain. Remove it and add the new one — " +
        `that is also how a client secret is rotated (${code})`,
    );
  }
  if (statusCode === 403) return forbidden(reply, message, `Better Auth's SSO plugin refused this: ${code}`);
  return refuseWithStatus(reply, statusCode, "VALIDATION", message, `Better Auth's SSO plugin refused this: ${code}`);
};

interface SanitizedProvider {
  providerId?: unknown;
  type?: unknown;
  issuer?: unknown;
  domain?: unknown;
  organizationId?: unknown;
  createdAt?: unknown;
  oidcConfig?: {
    discoveryEndpoint?: unknown;
    clientIdLastFour?: unknown;
    authorizationEndpoint?: unknown;
    tokenEndpoint?: unknown;
    userInfoEndpoint?: unknown;
    jwksEndpoint?: unknown;
    scopes?: unknown;
  };
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string" && v !== "")
    ? (value as string[])
    : undefined;

const instant = (value: unknown): string => {
  const at = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return at === undefined || Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
};

const providerRowView = (raw: SanitizedProvider, baseUrl: string): ConsoleSsoProviderRow | undefined => {
  const providerId = str(raw.providerId);
  const issuer = str(raw.issuer);
  const domain = str(raw.domain);
  if (providerId === undefined || issuer === undefined || domain === undefined) return undefined;
  const oidc = raw.oidcConfig ?? {};
  const scopes = strings(oidc.scopes);
  const clientIdLastFour = str(oidc.clientIdLastFour);
  return {
    providerId,
    kind: raw.type === "saml" ? "saml" : "oidc",
    issuer,
    domain,
    domains: boundDomains(domain),
    redirectUri: ssoRedirectUri(baseUrl, providerId),
    createdAt: instant(raw.createdAt),
    ...(str(oidc.discoveryEndpoint) === undefined ? {} : { discoveryEndpoint: str(oidc.discoveryEndpoint) as string }),
    ...(str(oidc.authorizationEndpoint) === undefined
      ? {}
      : { authorizationEndpoint: str(oidc.authorizationEndpoint) as string }),
    ...(str(oidc.tokenEndpoint) === undefined ? {} : { tokenEndpoint: str(oidc.tokenEndpoint) as string }),
    ...(str(oidc.userInfoEndpoint) === undefined ? {} : { userInfoEndpoint: str(oidc.userInfoEndpoint) as string }),
    ...(str(oidc.jwksEndpoint) === undefined ? {} : { jwksEndpoint: str(oidc.jwksEndpoint) as string }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(clientIdLastFour === undefined ? {} : { clientIdLastFour }),
  };
};

const NO_DOMAIN =
  "This organisation has no email domain of its own, so there is nothing to bind an identity provider to. " +
  "Personal organisations — the ones a gmail.com or outlook.com address creates — sign in with Google only.";

const OWNERS_ONLY =
  "Only an organisation owner can see or change how people sign in. " +
  "Ask whoever first claimed your organisation.";

export interface ConsoleSsoPageView {
  page: ConsoleSsoPage;
  rows: ConsoleSsoProviderRow[];
}

export const consoleSsoPage = (
  service: RegistryService,
  ctx: ConsoleApiContext,
): ((claims: RegistrySession, req: FastifyRequest) => Promise<ConsoleSsoPageView>) => {
  const tenancy = service.tenancy;
  return async (claims: RegistrySession, req: FastifyRequest): Promise<ConsoleSsoPageView> => {
    const auth = ctx.auth;
    const org = tenancy === undefined ? undefined : await tenancy.getOrg(claims.orgId);
    const orgDomain = org?.domain;
    const mayManage = claims.role === "owner";

    if (auth === undefined || (claims.role !== "owner" && claims.role !== "admin")) {
      return {
        rows: [],
        page: {
          rows: [],
          mayManage: false,
          ...(orgDomain === undefined ? {} : { orgDomain }),
          notYet: auth === undefined ? "This registry has no directory, so there is nothing to sign in to." : OWNERS_ONLY,
        },
      };
    }

    const listed = await auth.auth.api.listSSOProviders({ headers: toWebHeaders(req.headers) });
    const providers = (listed as { providers?: unknown }).providers;
    const rows: ConsoleSsoProviderRow[] = [];
    for (const raw of Array.isArray(providers) ? providers : []) {
      const candidate = raw as SanitizedProvider;
      if (str(candidate.organizationId) !== claims.orgId) continue;
      const row = providerRowView(candidate, ctx.baseUrl);
      if (row !== undefined) rows.push(row);
    }
    rows.sort((a, b) => a.providerId.localeCompare(b.providerId));

    return {
      rows,
      page: {
        rows,
        mayManage,
        ...(orgDomain === undefined ? {} : { orgDomain }),
        ...(orgDomain === undefined
          ? {}
          : { plannedRedirectUri: ssoRedirectUri(ctx.baseUrl, ssoProviderIdFor(orgDomain)) }),
        ...(orgDomain === undefined ? { notYet: NO_DOMAIN } : {}),
      },
    };
  };
};

export const registerConsoleSsoRoutes = (
  app: FastifyInstance,
  service: RegistryService,
  ctx: ConsoleApiContext,
): void => {
  const tenancy = service.tenancy;
  if (tenancy === undefined) return;
  const sessionOf = (req: FastifyRequest): RegistrySession => requireSession(req);
  const ssoPage = consoleSsoPage(service, ctx);

  const authOf = (reply: FastifyReply): NonNullable<ConsoleApiContext["auth"]> | undefined => {
    if (ctx.auth !== undefined) return ctx.auth;
    void notFound(reply, "This registry has no directory", "sign-in is Better Auth's, and this build has none");
    return undefined;
  };

  const requireOwner = (claims: RegistrySession, reply: FastifyReply, verb: string): boolean => {
    requireAdmin(claims, verb, OWNERS_ONLY);
    if (claims.role === "owner") return true;
    void forbidden(reply, "Owners only", `Only an organisation owner can ${verb}. ${OWNERS_ONLY}`);
    return false;
  };

  app.get(`${CONSOLE_API_PREFIX}/sso`, async (req, reply) => {
    const claims = sessionOf(req);
    requireAdmin(claims, "see how this organisation signs in");
    return sendConsole(reply, "GET /sso", (await ssoPage(claims, req)).page);
  });

  app.post(`${CONSOLE_API_PREFIX}/sso`, async (req, reply) => {
    const claims = sessionOf(req);
    if (!requireOwner(claims, reply, "add a sign-in provider")) return reply;
    const auth = authOf(reply);
    if (auth === undefined) return reply;

    const org = await tenancy.getOrg(claims.orgId);
    const domain = org?.domain;
    if (domain === undefined) {
      return forbidden(reply, "This organisation cannot use SSO", NO_DOMAIN);
    }

    const parsed = ConsoleSsoRegistration.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "That sign-in provider is missing something",
        detail:
          "An OIDC provider needs an issuer URL, a client id and a client secret. " +
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }

    const before = await ssoPage(claims, req);
    if (before.rows.length > 0) {
      const existing = before.rows[0] as ConsoleSsoProviderRow;
      return forbidden(
        reply,
        "This organisation already has a sign-in provider",
        `${existing.issuer} is registered for ${existing.domain}. Remove it first — that is also how a client ` +
          "secret is rotated, because a half-updated provider is an organisation that cannot sign in.",
      );
    }

    let discovered;
    try {
      discovered = await discoverSsoIssuer({
        issuer: parsed.data.issuer,
        ...(parsed.data.discoveryEndpoint === undefined
          ? {}
          : { discoveryEndpoint: parsed.data.discoveryEndpoint }),
      });
    } catch (error) {
      const refusal = ssoDiscoveryFailure(error);
      return forbidden(
        reply,
        "That issuer did not answer with an OpenID configuration",
        `${refusal.message} (${refusal.code}). Press Test on the provider's row, or check the issuer URL — an ` +
          "Okta org and its `default` authorisation server differ by a path.",
      );
    }

    const claimPolicy = ssoClaimPolicyFor(discovered.issuer);
    const providerId = ssoProviderIdFor(domain);
    try {
      await auth.auth.api.registerSSOProvider({
        headers: toWebHeaders(req.headers),
        body: {
          providerId,
          issuer: parsed.data.issuer,
          domain,
          organizationId: claims.orgId,
          oidcConfig: {
            clientId: parsed.data.clientId,
            clientSecret: parsed.data.clientSecret,
            pkce: true,
            skipDiscovery: true,
            discoveryEndpoint: discovered.discoveryEndpoint,
            authorizationEndpoint: discovered.authorizationEndpoint,
            tokenEndpoint: discovered.tokenEndpoint,
            jwksEndpoint: discovered.jwksEndpoint,
            ...(claimPolicy.mapping === undefined ? {} : { mapping: claimPolicy.mapping }),
            ...(discovered.userInfoEndpoint === undefined || !claimPolicy.hydrateUserInfoEndpoint
              ? {}
              : { userInfoEndpoint: discovered.userInfoEndpoint }),
            ...(discovered.tokenEndpointAuthentication === undefined
              ? {}
              : { tokenEndpointAuthentication: discovered.tokenEndpointAuthentication }),
            ...(parsed.data.scopes === undefined ? {} : { scopes: parsed.data.scopes }),
          },
        },
      });
    } catch (error) {
      return refuseFromAuth(reply, error, `${parsed.data.issuer} could not be registered`);
    }
    return sendConsole(reply, "POST /sso", (await ssoPage(claims, req)).page);
  });

  app.post(`${CONSOLE_API_PREFIX}/sso/domains`, async (req, reply) => {
    const claims = sessionOf(req);
    if (!requireOwner(claims, reply, "bind another mail domain")) return reply;
    const auth = authOf(reply);
    if (auth === undefined) return reply;

    const org = await tenancy.getOrg(claims.orgId);
    const orgDomain = org?.domain;
    if (orgDomain === undefined) {
      return forbidden(reply, "This organisation cannot use SSO", NO_DOMAIN);
    }

    const parsed = ConsoleSsoDomainBinding.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "That is not a mail domain",
        detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }
    const candidate = parsed.data.domain;

    if (!isSubDomainOf(candidate, orgDomain)) {
      return forbidden(
        reply,
        "That domain is not a sub-domain of yours",
        `${candidate} is not under ${orgDomain}, which is the only domain this organisation has proved it owns. ` +
          "A sub-domain is safe because whoever controls a domain's DNS controls every name under it; a separate " +
          `registration like ${candidate} is not, and binding it would let this organisation's identity provider ` +
          "sign in people it has never proved anything about. Domain verification — proving you own a second " +
          "registration — is the missing step, and this registry does not have it yet.",
      );
    }

    if ((await tenancy.findOrgByDomain(candidate)) !== undefined) {
      return forbidden(
        reply,
        "That sub-domain is already an organisation",
        `${candidate} signed in first and has an organisation of its own, with its own owner, its own tools and ` +
          "its own vault. Binding it here would let this organisation's identity provider sign in that " +
          "organisation's people. If the two should be one, whoever owns it has to close it first.",
      );
    }

    const before = await ssoPage(claims, req);
    const provider = before.rows[0];
    if (provider === undefined) {
      return forbidden(
        reply,
        "This organisation has no sign-in provider yet",
        "A bound domain is a domain your identity provider may sign in, so there has to be one to bind it to. " +
          "Add a provider first.",
      );
    }
    const bound = boundDomains(provider.domain);
    if (bound.includes(candidate)) {
      return forbidden(
        reply,
        "That domain is already bound",
        `${provider.issuer} already signs in ${candidate}. Nothing was changed.`,
      );
    }

    try {
      await (
        await auth.adapter()
      ).update({
        model: "ssoProvider",
        where: [{ field: "providerId", value: provider.providerId }],
        update: { domain: [...bound, candidate].join(",") },
      });
    } catch (error) {
      return refuseFromAuth(reply, error, `${candidate} could not be bound`);
    }

    return sendConsole(reply, "POST /sso/domains", (await ssoPage(claims, req)).page);
  });

  app.delete<{ Params: { providerId: string } }>(
    `${CONSOLE_API_PREFIX}/sso/:providerId`,
    async (req, reply) => {
      const claims = sessionOf(req);
      if (!requireOwner(claims, reply, "remove a sign-in provider")) return reply;
      const auth = authOf(reply);
      if (auth === undefined) return reply;

      const before = await ssoPage(claims, req);
      const target = before.rows.find((row) => row.providerId === req.params.providerId);
      if (target === undefined) {
        return notFound(
          reply,
          "No such sign-in provider here",
          `${JSON.stringify(req.params.providerId)} is not registered to your organisation`,
        );
      }
      try {
        await auth.auth.api.deleteSSOProvider({
          headers: toWebHeaders(req.headers),
          body: { providerId: target.providerId },
        });
      } catch (error) {
        return refuseFromAuth(reply, error, `${target.issuer} could not be removed`);
      }
      return sendConsole(reply, "DELETE /sso/:id", (await ssoPage(claims, req)).page);
    },
  );

  app.post<{ Params: { providerId: string } }>(
    `${CONSOLE_API_PREFIX}/sso/:providerId/test`,
    async (req, reply) => {
      const claims = sessionOf(req);
      if (!requireOwner(claims, reply, "test a sign-in provider")) return reply;
      const auth = authOf(reply);
      if (auth === undefined) return reply;

      const before = await ssoPage(claims, req);
      const target = before.rows.find((row) => row.providerId === req.params.providerId);
      if (target === undefined) {
        return notFound(
          reply,
          "No such sign-in provider here",
          `${JSON.stringify(req.params.providerId)} is not registered to your organisation`,
        );
      }

      let result: ConsoleSsoTestResult;
      try {
        const found = await discoverSsoIssuer({
          issuer: target.issuer,
          ...(target.discoveryEndpoint === undefined ? {} : { discoveryEndpoint: target.discoveryEndpoint }),
        });
        result = {
          reachable: true,
          issuer: found.issuer,
          discoveryEndpoint: found.discoveryEndpoint,
          authorizationEndpoint: found.authorizationEndpoint,
          tokenEndpoint: found.tokenEndpoint,
          jwksEndpoint: found.jwksEndpoint,
          ...(found.userInfoEndpoint === undefined ? {} : { userInfoEndpoint: found.userInfoEndpoint }),
          ...(found.scopesSupported === undefined ? {} : { scopesSupported: found.scopesSupported }),
        };
      } catch (error) {
        result = { reachable: false, refusal: ssoDiscoveryFailure(error) };
      }
      return sendConsole(reply, "POST /sso/:id/test", result);
    },
  );
};

export const identitySourcesFor = async (
  auth: NonNullable<ConsoleApiContext["auth"]>,
  userIds: readonly string[],
): Promise<Map<string, string>> => {
  const adapter = await auth.adapter();
  const sources = new Map<string, string>();
  for (const userId of userIds) {
    const accounts = await adapter.findMany<{ providerId?: unknown }>({
      model: "account",
      where: [{ field: "userId", value: userId }],
    });
    const ids = accounts
      .map((row) => (typeof row.providerId === "string" ? row.providerId : undefined))
      .filter((id): id is string => id !== undefined)
      .sort((a, b) => a.localeCompare(b));
    const first = ids[0];
    if (first === undefined) continue;
    if (first.startsWith("sso-")) {
      const provider = await adapter.findOne<{ domain?: unknown }>({
        model: "ssoProvider",
        where: [{ field: "providerId", value: first }],
      });
      const bound = provider === null ? [] : boundDomains(str(provider.domain) ?? "");
      const domain = bound[0];
      sources.set(userId, domain === undefined ? "sso" : `sso:${domain}`);
      continue;
    }
    sources.set(userId, first === "credential" ? "password" : first);
  }
  return sources;
};
