import { z } from "zod";
import { ConsoleIdentitySource, ConsoleSsoPage, ConsoleSsoTestResult } from "./sso.js";
import { ConsoleRegistrationPage } from "./registration.js";
import { ConsoleGroupDetail, ConsoleGroupInUse, ConsoleGroupsPage } from "./groups.js";

export * from "./sso.js";
export * from "./policy-requests.js";
export * from "./registration.js";
export * from "./groups.js";

export const CSRF_COOKIE = "vibtra_csrf";

export const CSRF_HEADER = "x-vibtra-csrf";

export const CONSOLE_API_PREFIX = "/api/console";

export const ORG_HANDLE_MIN_LENGTH = 2;
export const ORG_HANDLE_MAX_LENGTH = 39;

const ORG_HANDLE_PATTERN = /^[a-z0-9](?:-?[a-z0-9])*$/;

export const RESERVED_ORG_HANDLES: readonly string[] = [
  "login",
  "signin",
  "app",
  "assets",
  "accept-invitation",
  "connections",
  "tokens",
  "api",
  "auth",
  "oauth2",
  ".well-known",
  "scim",
  "mcp",
  "r",
  "v1",
  "tools",
  "healthz",
  "host-enrol",
  "host-channel",
  "device",
  "billing",
  "landing",
  "privacy",
  "terms",
  "legal",
  "pricing",
  "docs",
  "admin",
  "www",
];

export const isReservedOrgHandle = (value: string): boolean =>
  RESERVED_ORG_HANDLES.includes(value.trim().toLowerCase());

export const orgHandleProblem = (value: string): string | undefined => {
  if (value.length < ORG_HANDLE_MIN_LENGTH) {
    return `a handle is at least ${ORG_HANDLE_MIN_LENGTH} characters`;
  }
  if (value.length > ORG_HANDLE_MAX_LENGTH) {
    return `a handle is at most ${ORG_HANDLE_MAX_LENGTH} characters`;
  }
  if (!ORG_HANDLE_PATTERN.test(value)) {
    return "a handle is lower-case letters, digits and single hyphens, and cannot begin or end with a hyphen";
  }
  if (isReservedOrgHandle(value)) {
    return `${JSON.stringify(value)} is reserved — it is an address this registry already serves`;
  }
  return undefined;
};

export const ORG_HANDLE_HEADER = "x-vibtra-org";

export const CONSOLE_LOGIN_PATH = "/login";

export const CONSOLE_ASSETS_PREFIX = "/assets";

export const LANDING_ASSETS_PREFIX = "/landing";

export const consolePathFor = (handle: string, route = "/"): string => {
  const tail = route === "" || route === "/" ? "" : route.startsWith("/") ? route : `/${route}`;
  return `/${handle}${tail}`;
};

export const CONSOLE_AUTH_PREFIX = "/api/auth";

export const SCIM_BASE_PATH = "/scim/v2";

export const CONSOLE_ACCEPT_INVITATION_PATH = "/accept-invitation";

export const CONSOLE_INVITE_ROLES = ["member", "admin"] as const;

export const ConsoleInviteRole = z.enum(CONSOLE_INVITE_ROLES);
export type ConsoleInviteRole = z.infer<typeof ConsoleInviteRole>;

export const CONSOLE_DEV_ORIGINS: readonly string[] = [
  "http://localhost:5180",
  "http://127.0.0.1:5180",
];

export const CONSOLE_ADMIN_ONLY_CODE = "admin_only";

const ConsolePartial = z.object({
  partial: z.literal(true),
  reason: z.string().min(1),
});

export const ConsoleScope = z.object({
  kind: z.string().min(1),
  summary: z.string().min(1),
  subjects: z.array(z.string()),
  unknown: z.boolean(),
  subjectNames: z.array(z.string().min(1)).optional(),
});
export type ConsoleScope = z.infer<typeof ConsoleScope>;

export const ConsoleUsage = z.object({
  plan: z.string().min(1),
  planName: z.string().min(1).optional(),
  users: z.number().int().min(0),
  userLimit: z.number().int().min(0).nullable(),
  connections: z.number().int().min(0).optional(),
  connectionLimit: z.number().int().min(0).nullable().optional(),
  billingStatus: z.enum(["active", "past_due", "unpaid"]).optional(),
  billingStatusAt: z.string().min(1).optional(),
});
export type ConsoleUsage = z.infer<typeof ConsoleUsage>;

export const CONSOLE_JOIN_POLICIES = ["domain", "invite"] as const;
export const ConsoleJoinPolicy = z.enum(CONSOLE_JOIN_POLICIES);
export type ConsoleJoinPolicy = z.infer<typeof ConsoleJoinPolicy>;

export const ConsoleSession = z.object({
  email: z.string().min(1),
  issuer: z.string().min(1),
  orgId: z.string().min(1),
  orgName: z.string().min(1),
  handle: z.string().min(1),
  orgDomain: z.string().min(1).optional(),
  role: z.enum(["admin", "member"]),
  orgRole: z.enum(["owner", "admin", "member"]).optional(),
  joinPolicy: ConsoleJoinPolicy.optional(),
  operator: z.boolean().optional(),
  features: z.object({ builder: z.boolean() }).optional(),
  usage: ConsoleUsage,
});
export type ConsoleSession = z.infer<typeof ConsoleSession>;

export const ConsoleOrgNameRequest = z.object({ name: z.string().min(1).max(64) }).strict();
export type ConsoleOrgNameRequest = z.infer<typeof ConsoleOrgNameRequest>;

export const ConsoleToolDeploy = z.object({
  outcome: z.enum(["LIVE", "FAILED"]),
  url: z.string().min(1).optional(),
  at: z.string().min(1),
  receiptId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  commit: z
    .object({
      sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
      source: z.enum(["git", "fallback"]),
    })
    .optional(),
});
export type ConsoleToolDeploy = z.infer<typeof ConsoleToolDeploy>;

export const ConsoleInvitationCreated = z.object({
  invitationId: z.string().min(1),
  email: z.string().min(1),
  role: ConsoleInviteRole,
  expiresAt: z.string().min(1).optional(),
  emailed: z.boolean().optional(),
});
export type ConsoleInvitationCreated = z.infer<typeof ConsoleInvitationCreated>;

export const ConsoleInvitationRequest = z
  .object({ email: z.string().min(1), role: ConsoleInviteRole })
  .strict();
export type ConsoleInvitationRequest = z.infer<typeof ConsoleInvitationRequest>;

export const ConsolePersonRow = z.object({
  issuer: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().min(1),
  name: z.string().min(1).optional(),
  role: z.enum(["admin", "member"]),
  createdAt: z.string().min(1),
  memberId: z.string().min(1).optional(),
  orgRole: z.enum(["owner", "admin", "member"]).optional(),
  image: z.string().min(1).optional(),
  lastSeenAt: z.string().min(1).nullable().optional(),
  isYou: z.boolean().optional(),
  mayManage: z.boolean().optional(),
  identitySource: ConsoleIdentitySource.optional(),
  doorTokens: z.array(z.object({ tokenId: z.string().min(1), name: z.string().min(1) })).optional(),
});
export type ConsolePersonRow = z.infer<typeof ConsolePersonRow>;

export const ConsoleRoleRequest = z.object({
  role: z.enum(["owner", "admin", "member"]),
});
export type ConsoleRoleRequest = z.infer<typeof ConsoleRoleRequest>;

const ConsoleAccountClosure = z.object({
  closedAt: z.string(),
  email: z.string(),
  sessionsRevoked: z.boolean(),
  doorTokensRevoked: z.number().int().min(0),
  membershipRemoved: z.boolean(),
  retentionDays: z.number().int().positive(),
  notice: z.string(),
});

export const ConsolePeoplePage = z.object({
  rows: z.array(ConsolePersonRow),
  total: z.number().int().min(0),
  partial: ConsolePartial.optional(),
  mayManage: z.boolean().optional(),
  mailEnabled: z.boolean().optional(),
});
export type ConsolePeoplePage = z.infer<typeof ConsolePeoplePage>;

export const CONSOLE_RESPONSE_SCHEMAS = {
  "GET /session": ConsoleSession,
  "GET /people": ConsolePeoplePage,
  "POST /people/:id/role": ConsolePeoplePage,
  "DELETE /people/:id": ConsolePeoplePage,
  "POST /people/:id/sessions/revoke": ConsolePeoplePage,
  "POST /people/invitations": ConsoleInvitationCreated,
  "GET /groups": ConsoleGroupsPage,
  "POST /groups": ConsoleGroupDetail,
  "PATCH /groups/:id": ConsoleGroupDetail,
  "DELETE /groups/:id?inUse": ConsoleGroupInUse,
  "POST /groups/:id/members": ConsoleGroupDetail,
  "DELETE /groups/:id/members/:email": ConsoleGroupDetail,
  "GET /sso": ConsoleSsoPage,
  "POST /sso": ConsoleSsoPage,
  "DELETE /sso/:id": ConsoleSsoPage,
  "POST /sso/:id/test": ConsoleSsoTestResult,
  "POST /sso/domains": ConsoleSsoPage,
  "GET /registration": ConsoleRegistrationPage,
  "POST /registration/allowlist": ConsoleRegistrationPage,
  "POST /registration/waitlist/:id/admit": ConsoleRegistrationPage,
  "DELETE /registration/allowlist/:id": ConsoleRegistrationPage,
  "POST /account/close": ConsoleAccountClosure,
  "POST /org/name": ConsoleSession,
} as const;

export type ConsoleDoor = keyof typeof CONSOLE_RESPONSE_SCHEMAS;

export const BANNED_FIELD_FRAGMENTS: readonly string[] = [
  "secret",
  "credential",
  "password",
  "passphrase",
  "sealed",
  "ciphertext",
  "privatekey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearer",
  "tokenhash",
  "rawtoken",
  "envvalue",
];

const BANNED_FIELD_NAMES: readonly string[] = ["token", "key", "value", "values", "env"];

export const isBannedFieldName = (key: string): boolean => {
  const lower = key.toLowerCase();
  if (BANNED_FIELD_NAMES.includes(lower)) return true;
  return BANNED_FIELD_FRAGMENTS.some((fragment) => lower.includes(fragment));
};
