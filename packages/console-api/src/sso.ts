import { z } from "zod";

const ConsoleSsoKind = z.enum(["oidc", "saml"]);

export const ConsoleSsoProviderRow = z.object({
  providerId: z.string().min(1),
  kind: ConsoleSsoKind,
  issuer: z.string().min(1),
  domain: z.string().min(1),
  domains: z.array(z.string().min(1)).optional(),
  redirectUri: z.string().min(1),
  createdAt: z.string().min(1),
  discoveryEndpoint: z.string().min(1).optional(),
  authorizationEndpoint: z.string().min(1).optional(),
  tokenEndpoint: z.string().min(1).optional(),
  userInfoEndpoint: z.string().min(1).optional(),
  jwksEndpoint: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  clientIdLastFour: z.string().max(16).optional(),
});
export type ConsoleSsoProviderRow = z.infer<typeof ConsoleSsoProviderRow>;

export const ConsoleSsoPage = z.object({
  rows: z.array(ConsoleSsoProviderRow),
  mayManage: z.boolean(),
  orgDomain: z.string().min(1).optional(),
  plannedRedirectUri: z.string().min(1).optional(),
  notYet: z.string().min(1).optional(),
});
export type ConsoleSsoPage = z.infer<typeof ConsoleSsoPage>;

const idpUrl = (what: string) =>
  z
    .string()
    .url()
    .max(2048)
    .refine((u) => u.toLowerCase().startsWith("https://"), {
      message: `${what} must be an https URL — an http issuer would send your client secret in the clear`,
    })
    .refine(
      (u) => {
        try {
          const parsed = new URL(u);
          return parsed.username === "" && parsed.password === "";
        } catch {
          return false;
        }
      },
      { message: `${what} must not carry a username or password in the URL` },
    );

export const ConsoleSsoDomainBinding = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .toLowerCase()
    .regex(
      /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
      "A mail domain is labels of letters, digits and hyphens separated by dots — no scheme, no path, no @",
    ),
});
export type ConsoleSsoDomainBinding = z.infer<typeof ConsoleSsoDomainBinding>;

export const ConsoleSsoRegistration = z.object({
  issuer: idpUrl("issuer"),
  discoveryEndpoint: idpUrl("discoveryEndpoint").optional(),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(2048),
  scopes: z.array(z.string().min(1).max(64)).max(20).optional(),
});
export type ConsoleSsoRegistration = z.infer<typeof ConsoleSsoRegistration>;

export const ConsoleSsoTestResult = z.object({
  reachable: z.boolean(),
  issuer: z.string().min(1).optional(),
  discoveryEndpoint: z.string().min(1).optional(),
  authorizationEndpoint: z.string().min(1).optional(),
  tokenEndpoint: z.string().min(1).optional(),
  userInfoEndpoint: z.string().min(1).optional(),
  jwksEndpoint: z.string().min(1).optional(),
  scopesSupported: z.array(z.string().min(1)).optional(),
  refusal: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
});
export type ConsoleSsoTestResult = z.infer<typeof ConsoleSsoTestResult>;

export const SSO_SIGN_IN_PATH = "/sign-in/sso";

export const ConsoleIdentitySource = z.string().min(1).max(300);
export type ConsoleIdentitySource = z.infer<typeof ConsoleIdentitySource>;
