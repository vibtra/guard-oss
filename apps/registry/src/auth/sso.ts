import {
  sso,
  DiscoveryError,
  computeDiscoveryUrl,
  fetchDiscoveryDocument,
  normalizeUrl,
  selectTokenEndpointAuthMethod,
  validateDiscoveryDocument,
} from "@better-auth/sso";
import { AUTH_BASE_PATH } from "./fastify.js";

export const ssoRedirectUri = (baseUrl: string, providerId: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${AUTH_BASE_PATH}/sso/callback/${encodeURIComponent(providerId)}`;

export const ssoProviderIdFor = (domain: string): string =>
  `sso-${domain.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

export const boundDomains = (domainList: string): string[] =>
  domainList
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");

export const isSubDomainOf = (candidate: string, parent: string): boolean => {
  const child = candidate.trim().toLowerCase();
  const root = parent.trim().toLowerCase();
  if (child === "" || root === "" || child === root) return false;
  return child.endsWith(`.${root}`);
};

export const emailIsInDomain = (email: string, domainList: string): boolean => {
  const parts = email.trim().toLowerCase().split("@");
  const host = parts.length === 2 ? (parts[1] ?? "") : "";
  if (parts.length !== 2 || (parts[0] ?? "") === "" || host === "") return false;
  return boundDomains(domainList).some((domain) => host === domain);
};

export const ENTRA_ISSUER_HOST = "login.microsoftonline.com";

export const ENTRA_EMAIL_VERIFIED_CLAIM = "xms_edov";

export interface SsoClaimMapping {
  email: string;
  name: string;
  emailVerified: string;
}

export interface SsoClaimPolicy {
  mapping?: SsoClaimMapping;
  hydrateUserInfoEndpoint: boolean;
}

export const isEntraIssuer = (issuer: string): boolean => {
  let host: string;
  try {
    host = new URL(issuer).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === ENTRA_ISSUER_HOST;
};

export const ssoClaimPolicyFor = (issuer: string): SsoClaimPolicy =>
  isEntraIssuer(issuer)
    ? {
        mapping: { email: "email", name: "name", emailVerified: ENTRA_EMAIL_VERIFIED_CLAIM },
        hydrateUserInfoEndpoint: false,
      }
    : { hydrateUserInfoEndpoint: true };

interface StoredSsoProviderRow {
  providerId: string;
  issuer: string;
  domain: string;
  organizationId?: string | null;
}

interface SsoResolutionDatabase {
  findOne: (args: {
    model: string;
    where: Array<{ field: string; value: string }>;
  }) => Promise<unknown>;
}

const asProviderRow = (row: unknown): StoredSsoProviderRow | undefined => {
  if (typeof row !== "object" || row === null) return undefined;
  const candidate = row as Record<string, unknown>;
  const providerId = candidate["providerId"];
  const domain = candidate["domain"];
  if (typeof providerId !== "string" || typeof domain !== "string") return undefined;
  const issuer = candidate["issuer"];
  return { providerId, domain, issuer: typeof issuer === "string" ? issuer : "" };
};

export const registrySso = () =>
  sso({
    organizationProvisioning: { disabled: true },
    trustEmailVerified: true,
    resolveUser: async (input, context) => {
      const database = context.database as unknown as SsoResolutionDatabase;
      const provider = asProviderRow(
        await database.findOne({
          model: "ssoProvider",
          where: [{ field: "providerId", value: input.providerId }],
        }),
      );
      if (provider === undefined) {
        return {
          action: "reject",
          code: "SSO_PROVIDER_UNKNOWN",
          message: "That sign-in used a provider this registry no longer has.",
        };
      }
      const email = input.providerUser.email;
      if (!emailIsInDomain(email, provider.domain)) {
        return {
          action: "reject",
          code: "SSO_DOMAIN_MISMATCH",
          message:
            `${email} is not on ${provider.domain}, the domain this sign-in provider is registered for. ` +
            "A provider may only sign in people whose address is on its own domain.",
        };
      }
      if (input.providerUser.emailVerified !== true) {
        const fix = isEntraIssuer(provider.issuer)
          ? "whoever administers your Microsoft Entra ID tenant to tick the `email` and `" +
            ENTRA_EMAIL_VERIFIED_CLAIM +
            "` optional claims on the app registration (Entra's Email Domain Owner Verified claim — Entra " +
            "emits no `email_verified` claim at all, so it is the one this registry reads)."
          : "whoever administers your identity provider to release the `email_verified` claim (Okta does this " +
            "with the `email` scope).";
        return {
          action: "reject",
          code: "SSO_EMAIL_UNVERIFIED",
          message:
            `Your organisation's identity provider did not say that ${email} is a verified address, so this ` +
            "registry cannot use it. An unverified address can neither claim nor join an organisation. Ask " +
            fix,
        };
      }
      return { action: "continue" };
    },
    schema: {
      ssoProvider: {
        additionalFields: {
          createdAt: { type: "date", required: false, input: false, defaultValue: () => new Date() },
          clientSecretKeyId: { type: "string", required: false, input: false },
        },
      },
    },
    providersLimit: 10,
  });

const SSO_MUTATION_PATHS: readonly string[] = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
];

export const ssoAdminOnly = () => ({
  id: "vibtra-sso-admin-only",
  onRequest: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (!SSO_MUTATION_PATHS.some((p) => path === `${AUTH_BASE_PATH}${p}`)) return;
    return {
      response: new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    };
  },
});

const DISCOVERY_TIMEOUT_MS = 10_000;

const NOTHING_IS_TRUSTED = (): boolean => false;

export interface SsoDiscovery {
  issuer: string;
  discoveryEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
  scopesSupported?: string[];
  tokenEndpointAuthentication?: "client_secret_basic" | "client_secret_post" | "private_key_jwt";
}

export const discoverSsoIssuer = async (params: {
  issuer: string;
  discoveryEndpoint?: string;
}): Promise<SsoDiscovery> => {
  const issuer = params.issuer;
  const discoveryEndpoint = params.discoveryEndpoint ?? computeDiscoveryUrl(issuer);
  const document = await fetchDiscoveryDocument(discoveryEndpoint, DISCOVERY_TIMEOUT_MS, NOTHING_IS_TRUSTED);
  validateDiscoveryDocument(document, issuer);
  const userInfoEndpoint =
    typeof document.userinfo_endpoint === "string" && document.userinfo_endpoint !== ""
      ? normalizeUrl("userinfo_endpoint", document.userinfo_endpoint, issuer)
      : undefined;
  const scopesSupported = Array.isArray(document.scopes_supported) ? document.scopes_supported : undefined;
  return {
    issuer: document.issuer,
    discoveryEndpoint,
    authorizationEndpoint: normalizeUrl("authorization_endpoint", document.authorization_endpoint, issuer),
    tokenEndpoint: normalizeUrl("token_endpoint", document.token_endpoint, issuer),
    jwksEndpoint: normalizeUrl("jwks_uri", document.jwks_uri, issuer),
    tokenEndpointAuthentication: selectTokenEndpointAuthMethod(document, undefined),
    ...(userInfoEndpoint === undefined ? {} : { userInfoEndpoint }),
    ...(scopesSupported === undefined ? {} : { scopesSupported }),
  };
};

export const ssoDiscoveryFailure = (error: unknown): { code: string; message: string } => {
  if (!(error instanceof DiscoveryError)) throw error;
  return { code: error.code, message: error.message };
};
