export {
  CAPABILITY_NAMES,
  capabilitiesFor,
  connectionLimitFor,
  DEFAULT_PLAN_ID,
  DESIGN_PARTNER_DISCOUNT_PCT,
  hasCapability,
  isAtLimit,
  loadRegistryConfig,
  overflowSeatsFor,
  planFor,
  REGISTRY_CAPABILITIES,
  REGISTRY_PLANS,
  RegistryConfig,
  requireCapability,
  smallestPlanWith,
  planLimitsFor,
  METERED_PRICE_KEYS,
  userLimitFor,
  type HostedConfig,
  type PlannedOrg,
  type PlanLimits,
  type RegistryCapability,
  type RegistryPlan,
} from "./config.js";
export {
  defaultLandingDistDir,
  hasBuiltLanding,
  readBuiltLanding,
  registerLandingAssets,
  renderLandingPage,
} from "./landing.js";
export { registerRegistryRoutes, type RegistryRouteOptions } from "./routes.js";
export { registerHostedRoutes, signInRedirect } from "./routes-hosted.js";
export { registerConsoleApiRoutes, type ConsoleApiContext } from "./console-api/routes.js";
export {
  allowedConsoleOrigins,
  ensureCsrfCookie,
  mintCsrfToken,
  requireConsoleSession,
  requireCsrf,
  type ConsoleGuardContext,
} from "./console-api/guard.js";
export {
  createGroupStore,
  type GroupExpansion,
  type GroupMemberRow,
  type GroupRow,
  type GroupStore,
  type GroupUsage,
} from "./groups/store.js";
export { registryTeamOptions, teamsConsoleOnly, TEAM_ENDPOINT_PATHS } from "./auth/teams.js";
export { registerConsoleGroupRoutes } from "./console-api/groups.js";
export {
  createFileOrgStore,
  createTenancyStore,
  OrgHandleAliasRow,
  OrgRow,
  OrgTokenRow,
  type OrgRowInput,
  type OrgStore,
  type TenancyStore,
} from "./tenancy/store.js";
export {
  deriveOrgHandle,
  fallbackHandleOf,
  handleOf,
  handleSeedOf,
  isReservedOrgHandle,
  orgHandleProblem,
  RESERVED_ORG_HANDLES,
} from "./tenancy/handle.js";
export {
  createMemberDirectory,
  type AuthDbAdapter,
  type MemberDirectory,
  type OrgMemberRow,
  type OrgRecord,
} from "./tenancy/members.js";
export {
  applyOrgPlan,
  claimOrJoinOrg,
  planOrgForSignIn,
  PUBLIC_EMAIL_DOMAINS,
  type ClaimContext,
  type ClaimOutcome,
  type ClaimPlan,
  type SignInProfile,
} from "./tenancy/claim.js";
export {
  createRegistryAuth,
  devTrustedOrigins,
  SESSION_COOKIE_NAME,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  type RegistryAuth,
  type RegistryAuthOptions,
} from "./auth/better-auth.js";
export { assertTestAuthIsPermitted, testAuthEnabled } from "./auth/test-auth.js";
export { AUTH_BASE_PATH, googleRedirectUri, registerAuthHandler } from "./auth/fastify.js";
export {
  isOrgAdmin,
  notSignedIn,
  ORG_ROLES,
  readSession,
  registerSessionReader,
  requireSession,
  toWebHeaders,
  wireRole,
  type OrgRole,
  type RegistrySession,
  type SessionResolver,
} from "./auth/session.js";
export {
  bearerFrom,
  DOOR_TOKEN_PREFIX,
  SCIM_TOKEN_PREFIX,
  hashDoorToken,
  mintDoorToken,
  mintOrgToken,
  tokenKindOf,
  tokensEqual,
  type MintedDoorToken,
  type OrgTokenKind,
} from "./auth/tokens.js";
export {
  authenticateScimToken,
  type ScimOrg,
} from "./auth/guard.js";
export { expireCookie, parseCookies, serializeCookie, type CookieAttributes } from "./auth/cookies.js";
export {
  ENTERPRISE_FEATURES,
  ENTERPRISE_FEATURE_NAMES,
  enterpriseAvailability,
  enterpriseUnavailable,
  type EnterpriseAvailability,
  type EnterpriseFeatureId,
  type EnterpriseStatus,
  type RegistryEnterprise,
  type ScimAuthAdapter,
  type ScimDirectoryContext,
  type ScimDirectorySync,
  type ScimOutcome,
} from "./enterprise.js";
export {
  SCIM_CONTENT_TYPE,
  SCIM_ERROR_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_MAX_PAGE,
  SCIM_PATCH_SCHEMA,
  SCIM_USER_SCHEMA,
} from "./scim/protocol.js";
export { createRegistryService, type RegistryService, type RegistryServiceOptions } from "./service.js";
export { createVaultSealer, parseVaultKey, SEALED_PREFIX, type SealBinding, type VaultSealer } from "./vault/seal.js";
export { installCiphertextTripwire } from "./vault/tripwire.js";
export { sanitizeReturnPath } from "./auth/return-to.js";
