import { z } from "zod";
import { VibtraError } from "./errors.js";
import { assertTestAuthIsPermitted, testAuthEnabled } from "./auth/test-auth.js";
import { buildVaultKeyRing, splitVaultKeyList } from "./vault/seal.js";

export const REGISTRY_CAPABILITIES = [
  "ssoEnforcedOnDeploys",
  "driftDetection",
  "scim",
  "byoc",
] as const;
export type RegistryCapability = (typeof REGISTRY_CAPABILITIES)[number];

export const CAPABILITY_NAMES: Record<RegistryCapability, string> = {
  ssoEnforcedOnDeploys: "Enforced SSO on deploys",
  driftDetection: "Drift detection",
  scim: "Directory sync (SCIM)",
  byoc: "Bring your own cloud",
};

export interface RegistryPlan {
  id: string;
  name: string;
  userLimit: number | null;
  connectionLimit: number | null;
  capabilities: readonly RegistryCapability[];
  limits: PlanLimits;
}

export interface PlanLimits {
  sessionHours: number | null;
  sessionHoursHardCap: boolean;
  concurrentWorkspaces: number | null;
  sessionOverageCentsPerHour: number | null;
  appBoxes: number | null;
  appBoxAwakeHours: number | null;
  appBoxHardCap: boolean;
  storageGbPerBox: number | null;
  idleSleepMin: number | null;
  appBoxOverageCentsPerAwakeHour: number | null;
  extraBoxCentsPerMonth: number | null;
}

const FREE_LIMITS: PlanLimits = Object.freeze({
  sessionHours: 40,
  sessionHoursHardCap: true,
  concurrentWorkspaces: 1,
  sessionOverageCentsPerHour: null,
  appBoxes: 1,
  appBoxAwakeHours: 100,
  appBoxHardCap: true,
  storageGbPerBox: 2,
  idleSleepMin: 5,
  appBoxOverageCentsPerAwakeHour: null,
  extraBoxCentsPerMonth: null,
});

const CONTRACT_LIMITS: PlanLimits = Object.freeze({
  sessionHours: null,
  sessionHoursHardCap: false,
  concurrentWorkspaces: null,
  sessionOverageCentsPerHour: null,
  appBoxes: null,
  appBoxAwakeHours: null,
  appBoxHardCap: false,
  storageGbPerBox: null,
  idleSleepMin: null,
  appBoxOverageCentsPerAwakeHour: null,
  extraBoxCentsPerMonth: null,
});

const FREE_PLAN: RegistryPlan = {
  id: "free",
  name: "Free",
  userLimit: 5,
  connectionLimit: 3,
  capabilities: [],
  limits: FREE_LIMITS,
};

const TEAM_PLAN: RegistryPlan = {
  id: "team",
  name: "Team",
  userLimit: 25,
  connectionLimit: 10,
  capabilities: [],
  limits: Object.freeze({
    sessionHours: 250,
    sessionHoursHardCap: false,
    concurrentWorkspaces: 10,
    sessionOverageCentsPerHour: 50,
    appBoxes: 10,
    appBoxAwakeHours: 1000,
    appBoxHardCap: false,
    storageGbPerBox: 5,
    idleSleepMin: 15,
    appBoxOverageCentsPerAwakeHour: 10,
    extraBoxCentsPerMonth: 1000,
  }),
};

export const REGISTRY_PLANS: readonly RegistryPlan[] = [
  FREE_PLAN,
  TEAM_PLAN,
  {
    id: "business",
    name: "Business",
    userLimit: 100,
    connectionLimit: null,
    capabilities: ["ssoEnforcedOnDeploys", "driftDetection", "scim"],
    limits: Object.freeze({
      sessionHours: 1000,
      sessionHoursHardCap: false,
      concurrentWorkspaces: 40,
      sessionOverageCentsPerHour: 50,
      appBoxes: 25,
      appBoxAwakeHours: 2500,
      appBoxHardCap: false,
      storageGbPerBox: 10,
      idleSleepMin: 30,
      appBoxOverageCentsPerAwakeHour: 10,
      extraBoxCentsPerMonth: 1000,
    }),
  },
  {
    id: "enterprise",
    name: "Enterprise",
    userLimit: null,
    connectionLimit: null,
    capabilities: ["ssoEnforcedOnDeploys", "driftDetection", "scim", "byoc"],
    limits: CONTRACT_LIMITS,
  },
];

export const DEFAULT_PLAN_ID = FREE_PLAN.id;

export const planFor = (planId: string | undefined): RegistryPlan =>
  REGISTRY_PLANS.find((p) => p.id === planId) ?? FREE_PLAN;

export const planLimitsFor = (planId: string | undefined): PlanLimits => planFor(planId).limits;

export const RETIRED_PLAN_IDS: Readonly<Record<string, string>> = {
  entry: "team",
  "team-25": "team",
  "team-100": "business",
  unlimited: "enterprise",
};

export const DESIGN_PARTNER_DISCOUNT_PCT = 50;

export const overflowSeatsFor = (org: PlannedOrg | undefined, members: number): number => {
  const cap = userLimitFor(org);
  if (cap === null) return 0;
  return members > cap ? members - cap : 0;
};

export interface PlannedOrg {
  plan?: string;
  userLimit?: number;
  connectionLimit?: number;
  capabilities?: readonly string[];
}

export const userLimitFor = (org: PlannedOrg | undefined): number | null =>
  org?.userLimit ?? planFor(org?.plan).userLimit;

export const connectionLimitFor = (org: PlannedOrg | undefined, deploymentDefault?: number): number | null => {
  if (org?.connectionLimit !== undefined) return org.connectionLimit;
  const plan = planFor(org?.plan);
  return plan.id === DEFAULT_PLAN_ID && deploymentDefault !== undefined ? deploymentDefault : plan.connectionLimit;
};

export const isAtLimit = (count: number, limit: number | null): boolean => limit !== null && count >= limit;

export const capabilitiesFor = (org: PlannedOrg | undefined): readonly RegistryCapability[] => {
  const granted = new Set<string>(planFor(org?.plan).capabilities);
  for (const id of org?.capabilities ?? []) granted.add(id);
  return REGISTRY_CAPABILITIES.filter((id) => granted.has(id));
};

export const hasCapability = (org: PlannedOrg | undefined, id: RegistryCapability): boolean =>
  capabilitiesFor(org).includes(id);

export const smallestPlanWith = (id: RegistryCapability): RegistryPlan | undefined =>
  REGISTRY_PLANS.find((plan) => plan.capabilities.includes(id));

export const requireCapability = (org: PlannedOrg | undefined, id: RegistryCapability): void => {
  if (hasCapability(org, id)) return;
  const needed = smallestPlanWith(id);
  throw new VibtraError({
    code: "REGISTRY_LIMIT_EXCEEDED",
    message: `${CAPABILITY_NAMES[id]} is not on this organisation's plan`,
    detail:
      `${CAPABILITY_NAMES[id]} is available from the ${needed?.name ?? "next"} bucket up; this ` +
      `organisation is on ${planFor(org?.plan).name}. Nothing was changed. Ask us to move your ` +
      `organisation to a bucket that carries it.`,
  });
};

export const METERED_PRICE_KEYS = ["session_overage", "appbox_awake_overage", "appbox_extra_box"] as const;
export type MeteredPriceKey = (typeof METERED_PRICE_KEYS)[number];

export const splitStripePrices = (raw: string | undefined): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const planId = pair.slice(0, at).trim();
    const priceId = pair.slice(at + 1).trim();
    if (planId === "" || priceId === "") continue;
    map[planId] = priceId;
  }
  return map;
};

const TRUSTED_ORIGIN_EXAMPLE = "http://127.0.0.1:4799,http://localhost:4799";

const isBareOrigin = (value: string): boolean => {
  if (value.includes("*") || value.includes("?")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
};

const normalizeOrigin = (entry: string): string => {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return entry;
  }
  const bare =
    (url.pathname === "" || url.pathname === "/") &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  return bare ? url.origin : entry;
};

const splitTrustedOrigins = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(normalizeOrigin);

export const REGISTRATION_MODES = ["open", "allowlist"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

const BARE_MAIL_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;
export const isBareMailDomain = (value: string): boolean => BARE_MAIL_DOMAIN.test(value);

const UNSAFE_IN_CONTACT = /[\s\u0000-\u001f\u007f]/u;

const isOneAddress = (value: string): boolean => {
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const local = parts[0] ?? "";
  const host = parts[1] ?? "";
  return local !== "" && !UNSAFE_IN_CONTACT.test(local) && isBareMailDomain(host);
};

const registrationFromEnv = (env: NodeJS.ProcessEnv): HostedConfig["registration"] => {
  const rawMode = (env.REGISTRY_REGISTRATION ?? "").trim();
  const rawDomain = (env.REGISTRY_OPERATOR_DOMAIN ?? "").trim().toLowerCase();
  const rawContact = (env.REGISTRY_CONTACT_EMAIL ?? "").trim().toLowerCase();
  if (rawMode === "" && rawDomain === "" && rawContact === "") return undefined;

  const mode = rawMode === "" ? "open" : rawMode;
  if (mode !== "open" && mode !== "allowlist") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_REGISTRATION must be 'open' or 'allowlist'",
      detail:
        `got ${JSON.stringify(env.REGISTRY_REGISTRATION)}. \`open\` is every registry that has not set the ` +
        "variable: anybody who signs in with a verified address gets an organisation. `allowlist` means a first " +
        "sign-in that would CREATE one goes through only for the operator's own domain, for a listed address or " +
        "for a listed domain (apps/registry/README.md). A value this registry does not know is refused here rather " +
        "than read as one of them, because either guess is a deployment quietly doing the opposite of what was meant.",
    });
  }
  if (rawDomain !== "" && !isBareMailDomain(rawDomain)) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_OPERATOR_DOMAIN must be a bare mail domain",
      detail:
        `got ${JSON.stringify(env.REGISTRY_OPERATOR_DOMAIN)} — no scheme, no path, no port, no "@", no ` +
        "whitespace, and at least one dot, e.g. vibtra.app. It is the domain the organisation that operates this " +
        "registry has claimed; its admins read the Sign-ups section and its owners manage the list. Anything else " +
        "would match no organisation at all, and the section would simply never appear.",
    });
  }
  if (rawContact !== "" && !isOneAddress(rawContact)) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_CONTACT_EMAIL must be one email address",
      detail:
        `got ${JSON.stringify(env.REGISTRY_CONTACT_EMAIL)} — exactly one "@", something on both sides of it, no ` +
        "whitespace, and a bare mail domain on the right. This address is shown to anybody who reaches the " +
        "sign-in screen, so a value that is not one address would be printed at strangers as if it were.",
    });
  }
  return {
    mode,
    ...(rawDomain === "" ? {} : { operatorDomain: rawDomain }),
    ...(rawContact === "" ? {} : { contactEmail: rawContact }),
  };
};

const ownerEmailFromEnv = (env: NodeJS.ProcessEnv): { ownerEmail?: string } => {
  const raw = (env.REGISTRY_OWNER_EMAIL ?? "").trim().toLowerCase();
  if (raw === "") return {};
  if (!isOneAddress(raw)) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_OWNER_EMAIL must be one email address",
      detail:
        `got ${JSON.stringify(env.REGISTRY_OWNER_EMAIL)} — exactly one "@", something on both sides of it, no ` +
        "whitespace, and a bare mail domain on the right. It names the one person who may create this server's " +
        "organisation on first sign-in even from a personal mailbox, so it has to match a single address exactly.",
    });
  }
  return { ownerEmail: raw };
};

const guardQuickStartFromEnv = (env: NodeJS.ProcessEnv): { guardQuickStart?: true } => {
  const raw = env.GUARD_QUICK_START ?? "";
  if (raw === "") return {};
  if (raw !== "1") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "GUARD_QUICK_START must be 1 or empty",
      detail:
        `got ${JSON.stringify(env.GUARD_QUICK_START)} — 1 makes a new organisation open in Enforce with the starter ` +
        "rules, for a trial server. Leave it empty on a server your company uses: a new organisation then opens in Monitor.",
    });
  }
  return { guardQuickStart: true };
};

const noPeopleLimitFromEnv = (env: NodeJS.ProcessEnv): { noPeopleLimit?: true } => {
  const raw = env.GUARD_NO_PEOPLE_LIMIT ?? "";
  if (raw === "") return {};
  if (raw !== "1") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "GUARD_NO_PEOPLE_LIMIT must be 1 or empty",
      detail: `got ${JSON.stringify(env.GUARD_NO_PEOPLE_LIMIT)} — 1 removes the plan's people limit. The self-hosted Compose file sets it.`,
    });
  }
  return { noPeopleLimit: true };
};

const multiOrgFromEnv = (env: NodeJS.ProcessEnv): { singleOrg?: true } => {
  const raw = env.GUARD_MULTI_ORG ?? "";
  if (raw === "" || raw === "1") return {};
  if (raw !== "0") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "GUARD_MULTI_ORG must be 1, 0 or empty",
      detail:
        `got ${JSON.stringify(env.GUARD_MULTI_ORG)} — 0 keeps this server to one organisation: after the first sign-in ` +
        "creates it, a sign-in that would create another is refused. 1 or empty lets any new domain create its own. " +
        "The self-hosted Compose file sets 0.",
    });
  }
  return { singleOrg: true };
};

const HostedConfig = z.object({
  baseUrl: z.string().url(),
  extraTrustedOrigins: z
    .array(
      z.string().refine(isBareOrigin, (value) => ({
        message:
          `REGISTRY_EXTRA_TRUSTED_ORIGINS takes comma-separated absolute origins with no path, ` +
          `e.g. ${TRUSTED_ORIGIN_EXAMPLE} — got ${JSON.stringify(value)}`,
      })),
    )
    .optional(),
  sessionSecret: z.string().min(32, "REGISTRY_SESSION_SECRET must be at least 32 characters"),
  gateSigningSecret: z.string().min(32, "REGISTRY_GATE_SIGNING_SECRET must be at least 32 characters").optional(),
  oidc: z.object({
    issuer: z.string().url().default("https://accounts.google.com"),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    provider: z.enum(["google", "oidc"]).optional(),
    name: z.string().min(1).max(60).optional(),
  }),
  testAuth: z.boolean().optional(),
  defaultConnectionLimit: z.number().int().min(0).optional(),
  stripeWebhookSecret: z.string().min(1).optional(),
  stripeSecretKey: z.string().min(1).optional(),
  stripePrices: z.record(z.string().min(1), z.string().min(1)).optional(),
  resendApiKey: z.string().min(1).optional(),
  mailFrom: z.string().min(1).optional(),
  vaultKey: z.string().min(1).optional(),
  vaultKeyPrevious: z.array(z.string().min(1)).optional(),
  openbaoAddr: z.string().url().optional(),
  openbaoRoleId: z.string().min(1).optional(),
  openbaoSecretId: z.string().min(1).optional(),
  openbaoNamespacePrefix: z.string().min(1).optional(),
  registration: z
    .object({
      mode: z.enum(REGISTRATION_MODES),
      operatorDomain: z.string().min(1).optional(),
      contactEmail: z.string().min(1).optional(),
    })
    .optional(),
  ownerEmail: z.string().min(3).optional(),
  guardQuickStart: z.boolean().optional(),
  noPeopleLimit: z.boolean().optional(),
  singleOrg: z.boolean().optional(),
});
export type HostedConfig = z.infer<typeof HostedConfig>;

export const RegistryConfig = z.object({
  mode: z.enum(["single", "hosted"]).default("single"),
  dataDir: z.string().optional(),
  databaseUrl: z.string().optional(),
  hosted: HostedConfig.optional(),
});
export type RegistryConfig = z.infer<typeof RegistryConfig>;

export const registrationOf = (
  hosted: Pick<HostedConfig, "registration"> | undefined,
): { mode: RegistrationMode; operatorDomain?: string; contactEmail?: string } =>
  hosted?.registration ?? { mode: "open" };

export const GATE_SECRET_FALLBACK_NOTICE =
  "[vibtra-registry] REGISTRY_GATE_SIGNING_SECRET is not set, so REGISTRY_SESSION_SECRET is being used for BOTH " +
  "console sessions and the tool gate's signing key at rest (DECISIONS.md host-9). That still works and nothing is " +
  "broken — but rotating REGISTRY_SESSION_SECRET will then also make every `jwks` row unreadable and take the tool " +
  "gate down with it. Set REGISTRY_GATE_SIGNING_SECRET (openssl rand -hex 32) to separate the two; " +
  "docs/deploy-registry-aws.md §1.5 has both rotation runbooks.";

export const gateSigningSecretFor = (hosted: Pick<HostedConfig, "gateSigningSecret" | "sessionSecret">): string =>
  hosted.gateSigningSecret ?? hosted.sessionSecret;

export type ConfigNotice = (line: string) => void;

export const oidcProviderFromEnv = (env: NodeJS.ProcessEnv): { provider?: "google" | "oidc"; name?: string } => {
  const provider = (env.REGISTRY_OIDC_PROVIDER ?? "").trim();
  const name = (env.REGISTRY_OIDC_NAME ?? "").trim();
  if (provider === "" || provider === "google") return provider === "" ? {} : { provider: "google" };
  if (provider !== "oidc") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_OIDC_PROVIDER must be 'google' or 'oidc'",
      detail: `got ${JSON.stringify(env.REGISTRY_OIDC_PROVIDER)}`,
    });
  }
  const issuer = (env.REGISTRY_OIDC_ISSUER ?? "").trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(issuer);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_OIDC_PROVIDER=oidc requires REGISTRY_OIDC_ISSUER",
      detail: "Set REGISTRY_OIDC_ISSUER to your identity provider's issuer URL, for example https://login.example.com/realms/acme. The registry reads <issuer>/.well-known/openid-configuration.",
    });
  }
  if (parsed.protocol === "http:" && (env.REGISTRY_BASE_URL ?? "").trim().startsWith("https://")) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_OIDC_ISSUER must use https",
      detail: `got ${JSON.stringify(issuer)} while REGISTRY_BASE_URL is https. Plain http is accepted only on a local http registry.`,
    });
  }
  return { provider: "oidc", ...(name === "" ? {} : { name }) };
};

export const loadRegistryConfig = (
  env: NodeJS.ProcessEnv,
  notice: ConfigNotice = () => undefined,
): RegistryConfig => {
  const mode = env.REGISTRY_MODE === "hosted" ? "hosted" : "single";
  if (env.REGISTRY_MODE !== undefined && env.REGISTRY_MODE !== "hosted" && env.REGISTRY_MODE !== "single") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "REGISTRY_MODE must be 'single' or 'hosted'",
      detail: `got ${JSON.stringify(env.REGISTRY_MODE)}`,
    });
  }

  const raw: Record<string, unknown> = {
    mode,
    dataDir: env.VIBTRA_REGISTRY_DATA_DIR,
    databaseUrl: env.DATABASE_URL,
  };

  if (mode === "hosted") {
    const missing = ["REGISTRY_BASE_URL", "REGISTRY_SESSION_SECRET", "REGISTRY_OIDC_CLIENT_ID", "REGISTRY_OIDC_CLIENT_SECRET"].filter(
      (name) => (env[name] ?? "").trim() === "",
    );
    if (missing.length > 0) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Hosted mode is missing required configuration",
        detail: `REGISTRY_MODE=hosted requires: ${missing.join(", ")} (see apps/registry/README.md)`,
      });
    }
    if ((env.DATABASE_URL ?? "").trim() === "" && env.NODE_ENV === "production") {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Hosted mode requires DATABASE_URL",
        detail:
          "REGISTRY_MODE=hosted keeps people, sessions, organizations and memberships in Postgres (migration " +
          "0006_better_auth.sql). Without DATABASE_URL they live in this process's memory: every restart signs " +
          "everyone out and a second replica sees a different world. Set DATABASE_URL, or unset NODE_ENV=production " +
          "if this really is a dev box (see apps/registry/README.md).",
      });
    }
    assertTestAuthIsPermitted(env);
    raw.hosted = {
      baseUrl: env.REGISTRY_BASE_URL,
      ...(splitTrustedOrigins(env.REGISTRY_EXTRA_TRUSTED_ORIGINS).length === 0
        ? {}
        : { extraTrustedOrigins: splitTrustedOrigins(env.REGISTRY_EXTRA_TRUSTED_ORIGINS) }),
      sessionSecret: env.REGISTRY_SESSION_SECRET,
      ...((): { gateSigningSecret?: string } => {
        const own = (env.REGISTRY_GATE_SIGNING_SECRET ?? "").trim();
        if (own !== "") return { gateSigningSecret: own };
        notice(GATE_SECRET_FALLBACK_NOTICE);
        return {};
      })(),
      oidc: {
        ...((env.REGISTRY_OIDC_ISSUER ?? "").trim() === "" ? {} : { issuer: env.REGISTRY_OIDC_ISSUER }),
        clientId: env.REGISTRY_OIDC_CLIENT_ID,
        clientSecret: env.REGISTRY_OIDC_CLIENT_SECRET,
        ...oidcProviderFromEnv(env),
      },
      ...(testAuthEnabled(env) ? { testAuth: true } : {}),
      ...((env.REGISTRY_FREE_CONNECTIONS ?? "").trim() === ""
        ? {}
        : { defaultConnectionLimit: Number(env.REGISTRY_FREE_CONNECTIONS) }),
      ...((env.REGISTRY_STRIPE_WEBHOOK_SECRET ?? "").trim() === ""
        ? {}
        : { stripeWebhookSecret: env.REGISTRY_STRIPE_WEBHOOK_SECRET }),
      ...((env.REGISTRY_STRIPE_SECRET_KEY ?? "").trim() === ""
        ? {}
        : { stripeSecretKey: (env.REGISTRY_STRIPE_SECRET_KEY ?? "").trim() }),
      ...(Object.keys(splitStripePrices(env.REGISTRY_STRIPE_PRICES)).length === 0
        ? {}
        : { stripePrices: splitStripePrices(env.REGISTRY_STRIPE_PRICES) }),
      ...((env.RESEND_API_KEY ?? "").trim() === "" ? {} : { resendApiKey: (env.RESEND_API_KEY ?? "").trim() }),
      ...((env.REGISTRY_MAIL_FROM ?? "").trim() === ""
        ? {}
        : { mailFrom: (env.REGISTRY_MAIL_FROM ?? "").trim() }),
      ...((env.VIBTRA_VAULT_KEY ?? "").trim() === "" ? {} : { vaultKey: env.VIBTRA_VAULT_KEY }),
      ...(splitVaultKeyList(env.VIBTRA_VAULT_KEY_PREVIOUS).length === 0
        ? {}
        : { vaultKeyPrevious: splitVaultKeyList(env.VIBTRA_VAULT_KEY_PREVIOUS) }),
      ...((env.OPENBAO_ADDR ?? "").trim() === "" ? {} : { openbaoAddr: (env.OPENBAO_ADDR ?? "").trim() }),
      ...((env.OPENBAO_ROLE_ID ?? "").trim() === "" ? {} : { openbaoRoleId: (env.OPENBAO_ROLE_ID ?? "").trim() }),
      ...((env.OPENBAO_SECRET_ID ?? "").trim() === "" ? {} : { openbaoSecretId: (env.OPENBAO_SECRET_ID ?? "").trim() }),
      ...((env.OPENBAO_NAMESPACE_PREFIX ?? "").trim() === ""
        ? {}
        : { openbaoNamespacePrefix: (env.OPENBAO_NAMESPACE_PREFIX ?? "").trim() }),
      ...(() => {
        const registration = registrationFromEnv(env);
        return registration === undefined ? {} : { registration };
      })(),
      ...ownerEmailFromEnv(env),
      ...guardQuickStartFromEnv(env),
      ...noPeopleLimitFromEnv(env),
      ...multiOrgFromEnv(env),
    };
  }

  const parsed = RegistryConfig.safeParse(raw);
  if (!parsed.success) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "Invalid registry configuration",
      detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    });
  }
  const hostedConfig = parsed.data.hosted;
  if (hostedConfig !== undefined) {
    if (hostedConfig.vaultKey !== undefined) {
      buildVaultKeyRing(hostedConfig.vaultKey, hostedConfig.vaultKeyPrevious ?? []);
    } else if ((hostedConfig.vaultKeyPrevious ?? []).length > 0) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "VIBTRA_VAULT_KEY_PREVIOUS is set but VIBTRA_VAULT_KEY is not",
        detail:
          "previous keys only ever OPEN rows — nothing is sealed without a current key, so this registry would " +
          "come up with the vault disabled. Set VIBTRA_VAULT_KEY to the key you are rotating TO (see " +
          'apps/registry/README.md, "Rotating the vault key").',
      });
    }
    const openbao: Array<[string, unknown]> = [
      ["OPENBAO_ADDR", hostedConfig.openbaoAddr],
      ["OPENBAO_ROLE_ID", hostedConfig.openbaoRoleId],
      ["OPENBAO_SECRET_ID", hostedConfig.openbaoSecretId],
    ];
    const set = openbao.filter(([, value]) => value !== undefined).map(([name]) => name);
    if (set.length > 0 && set.length < openbao.length) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "OpenBao is half configured",
        detail:
          `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set but ` +
          `${openbao
            .filter(([, value]) => value === undefined)
            .map(([name]) => name)
            .join(", ")} ${openbao.length - set.length === 1 ? "is" : "are"} not. ` +
          "OPENBAO_ADDR is the switch that makes OpenBao's transit engine the org vault's current key, and the " +
          "AppRole is how this registry logs in to it — with one missing, the vault would either refuse every " +
          "credential or quietly keep sealing under VIBTRA_VAULT_KEY. Set all three or none (see " +
          "docs/openbao.md). No value is echoed.",
      });
    }
    if (hostedConfig.resendApiKey !== undefined && hostedConfig.mailFrom === undefined) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Mail is half configured",
        detail:
          "RESEND_API_KEY is set but REGISTRY_MAIL_FROM is not. Resend sends only from a domain it has verified, " +
          "so this registry would call the API for every invitation and be refused. Set REGISTRY_MAIL_FROM to the " +
          'verified sender (e.g. "Vibtra <no-reply@vibtra.app>"), or unset RESEND_API_KEY and keep the ' +
          "copy-the-link path. No value is echoed.",
      });
    }
    const stripePrices = hostedConfig.stripePrices ?? {};
    if (
      hostedConfig.stripeSecretKey !== undefined &&
      /^(sk|rk)_live_/.test(hostedConfig.stripeSecretKey) &&
      (env.REGISTRY_STRIPE_LIVE ?? "").trim() !== "1"
    ) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "REGISTRY_STRIPE_SECRET_KEY is a LIVE key",
        detail:
          "this registry refuses a live-mode Stripe key unless REGISTRY_STRIPE_LIVE=1 is also set — test mode is " +
          "the only mode this build has been exercised in, and taking real money is a switch somebody flips on " +
          "purpose. Use a test key (sk_test_…), or set REGISTRY_STRIPE_LIVE=1. No value is echoed.",
      });
    }
    if (hostedConfig.stripeSecretKey !== undefined && Object.keys(stripePrices).length === 0) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Stripe is half configured",
        detail:
          "REGISTRY_STRIPE_SECRET_KEY is set but REGISTRY_STRIPE_PRICES is empty, so no bucket is self-serve and " +
          "the checkout door would refuse every press — a live Stripe key held for nothing. Set the map " +
          "(planId=priceId, comma-separated) or unset the key and stay on the invoicing path. No value is echoed.",
      });
    }
    if (hostedConfig.stripeSecretKey === undefined && Object.keys(stripePrices).length > 0) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "REGISTRY_STRIPE_PRICES is set but REGISTRY_STRIPE_SECRET_KEY is not",
        detail:
          "a price map with no key behind it is a knob that reads as live and does nothing " +
          "(OPENBAO_NAMESPACE_PREFIX's own rule). Set the key too, or unset the map.",
      });
    }
    for (const planId of Object.keys(stripePrices)) {
      if ((METERED_PRICE_KEYS as readonly string[]).includes(planId)) continue;
      const known = REGISTRY_PLANS.find((plan) => plan.id === planId);
      if (known !== undefined && known.id === DEFAULT_PLAN_ID) {
        throw new VibtraError({
          code: "VALIDATION",
          message: "The Free bucket has no price",
          detail: "REGISTRY_STRIPE_PRICES names free, which is the bucket every new org starts on at no charge (m3-4). Remove it.",
        });
      }
      if (known === undefined) {
        throw new VibtraError({
          code: "VALIDATION",
          message: "REGISTRY_STRIPE_PRICES names a bucket this registry does not have",
          detail:
            `${JSON.stringify(planId)} is not a bucket in REGISTRY_PLANS (apps/registry/src/config.ts). The ` +
            `buckets are: ${REGISTRY_PLANS.map((plan) => plan.id).join(", ")}. A typo here would make a bucket ` +
            "quietly non-self-serve for the life of this deployment. No price id is echoed.",
        });
      }
      if (known.userLimit === null && known.connectionLimit === null) {
        throw new VibtraError({
          code: "VALIDATION",
          message: "The unmetered bucket cannot be self-serve",
          detail:
            `${JSON.stringify(planId)} meters nothing, which is this registry's enterprise bucket — the founder's ` +
            "pay-2 answer keeps it on invoicing, because a bucket with no ceiling is a conversation and not a " +
            "checkout. Remove it from REGISTRY_STRIPE_PRICES.",
        });
      }
    }
    if (hostedConfig.mailFrom !== undefined && hostedConfig.resendApiKey === undefined) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "REGISTRY_MAIL_FROM is set but RESEND_API_KEY is not",
        detail:
          "a sender with no transport behind it sends nothing, so this registry would ignore it entirely — a knob " +
          "that reads as live and does nothing is worse than an absent one (OPENBAO_NAMESPACE_PREFIX's own rule). " +
          "Set RESEND_API_KEY too, or unset REGISTRY_MAIL_FROM.",
      });
    }
    if (hostedConfig.openbaoNamespacePrefix !== undefined && hostedConfig.openbaoAddr === undefined) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "OPENBAO_NAMESPACE_PREFIX is set but OPENBAO_ADDR is not",
        detail:
          "the namespace prefix only means anything when the org vault seals through OpenBao, so this registry " +
          "would ignore it entirely — a knob that reads as live and does nothing is worse than an absent one. " +
          "Set OPENBAO_ADDR with the AppRole, or unset the prefix (see docs/openbao.md).",
      });
    }
  }
  return parsed.data;
};
