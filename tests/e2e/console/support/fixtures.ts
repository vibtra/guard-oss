import {
  ConsolePeoplePage,
  ConsolePolicyGrantsPage,
  ConsolePolicyRequestsPage,
  ConsoleSession,
} from "@vibtra/console-api";
import {
  GUARD_STAFF_NOTICE_TEMPLATE,
  GuardActivityPage,
  GuardDeviceRow,
  GuardDevicesPage,
  GuardEnrolLink,
  GuardEnrolLinksPage,
  GuardEventRow,
  type GuardInterceptionOffReason,
  GuardOverviewPage,
  GuardRuleTestResult,
  GuardRulesPage,
  GuardServicesPage,
  GuardSettingsPage,
  defaultGuardSettings,
  seedCatalogue,
} from "@vibtra/guard-contract";

const NOW = Date.now();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const iso = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString();

export const ADA = { userId: "usr_ada", email: "ada@fernwood.example", name: "Ada Park" };
export const GRACE = { userId: "usr_grace", email: "grace@fernwood.example", name: "Grace Ho" };

export const DEVICE_ID = "gdev_0123456789abcdef";
export const DEVICE_ID_2 = "gdev_fedcba9876543210";

export const event = (over: Partial<GuardEventRow> = {}): GuardEventRow =>
  GuardEventRow.parse({
    eventId: "gev_00000000000000a1",
    occurredAt: iso(-5 * MIN),
    kind: "content",
    action: "blocked",
    serviceId: "openai-chatgpt",
    serviceName: "ChatGPT",
    host: "chatgpt.com",
    port: 443,
    method: "POST",
    pathHint: "/backend-api",
    app: { bundleId: "com.google.Chrome", name: "Google Chrome" },
    ruleId: "gcr_0000aaaa",
    ruleName: "Tax file numbers",
    ruleKind: "content",
    matchType: "au-tfn",
    matchCount: 1,
    snippet: "123***782",
    bytes: 2048,
    bundleVersion: 3,
    deviceId: DEVICE_ID,
    hostname: "adas-mbp",
    person: ADA,
    receivedAt: iso(-4 * MIN),
    ...over,
  });

export const overview = (over: Partial<GuardOverviewPage> = {}): GuardOverviewPage =>
  GuardOverviewPage.parse({
    windowDays: 7,
    clientMode: "monitor",
    totals: { people: 2, devices: 2, quietDevices: 1, services: 3, events: 128, blocked: 4, asked: 2, openRequests: 1 },
    services: [
      { serviceId: "openai-chatgpt", name: "ChatGPT", category: "chat", people: 2, devices: 2, events: 90, blocked: 3, bytes: 1_572_864, lastSeenAt: iso(-5 * MIN) },
      { serviceId: "anthropic-claude", name: "Claude", category: "chat", people: 1, devices: 1, events: 30, blocked: 1, bytes: 40_960, lastSeenAt: iso(-2 * HOUR) },
      { serviceId: "github-copilot", name: "GitHub Copilot", category: "coding", people: 1, devices: 1, events: 8, blocked: 0, bytes: 900 },
    ],
    trend: Array.from({ length: 7 }, (_, i) => ({ day: new Date(NOW - (6 - i) * DAY).toISOString().slice(0, 10), events: 10 + i * 3, blocked: i % 3 === 0 ? 1 : 0, people: 2 })),
    topBlocks: [{ ruleId: "gcr_0000aaaa", ruleName: "Tax file numbers", kind: "content", count: 3 }],
    topApps: [{ app: "Google Chrome", bundleId: "com.google.Chrome", events: 100 }],
    recent: [event()],
    noDevicesYet: false,
    ...over,
  });

export const activity = (over: Partial<GuardActivityPage> = {}): GuardActivityPage =>
  GuardActivityPage.parse({
    rows: [
      event(),
      event({
        eventId: "gev_00000000000000a2",
        kind: "flow",
        action: "observed",
        ruleId: undefined,
        ruleName: undefined,
        ruleKind: undefined,
        matchType: undefined,
        matchCount: undefined,
        snippet: undefined,
        serviceId: "anthropic-claude",
        serviceName: "Claude",
        host: "claude.ai",
        app: { bundleId: "com.anthropic.claudefordesktop", name: "Claude" },
        person: GRACE,
      }),
    ],
    nextCursor: "c_2",
    total: 3,
    ...over,
  });

export const rulesPage = (over: Partial<GuardRulesPage> = {}): GuardRulesPage =>
  GuardRulesPage.parse({
    document: {
      version: 3,
      defaultAction: "allow",
      serviceRules: [{ ruleId: "gsr_0000bbbb", serviceId: "deepseek-chat", audience: { kind: "org" }, action: "block", enabled: true, note: "Data leaves Australia" }],
      contentRules: [{ ruleId: "gcr_0000aaaa", name: "Tax file numbers", detector: { kind: "au-tfn" }, services: "*", audience: { kind: "org" }, action: "block", enabled: true }],
    },
    updatedAt: iso(-DAY),
    updatedBy: ADA.email,
    clientMode: "enforce",
    groups: [{ id: "team_eng", name: "Engineering" }],
    services: [
      { serviceId: "openai-chatgpt", name: "ChatGPT", category: "chat" },
      { serviceId: "deepseek-chat", name: "DeepSeek", category: "chat" },
    ],
    ...over,
  });

export const testResult = (over: Partial<GuardRuleTestResult> = {}): GuardRuleTestResult =>
  GuardRuleTestResult.parse({
    serviceId: "openai-chatgpt",
    serviceName: "ChatGPT",
    intercepted: true,
    flow: { action: "allow", source: "default" },
    content: [{ ruleId: "gcr_0000aaaa", ruleName: "Tax file numbers", matchType: "au-tfn", count: 1, action: "block", example: "123***782", excepted: false }],
    verdict: "blocked",
    explanation: "The rule “Tax file numbers” blocks a tax file number sent to ChatGPT.",
    enforced: false,
    ...over,
  });

export const deviceRow = (over: Partial<GuardDeviceRow> = {}): GuardDeviceRow =>
  GuardDeviceRow.parse({
    deviceId: DEVICE_ID,
    hostname: "adas-mbp",
    serialNumber: "C02TEST0001",
    modelIdentifier: "Mac15,3",
    osVersion: "26.0",
    agentVersion: "0.1.0",
    person: ADA,
    status: "active",
    clientMode: "monitor",
    enrolledAt: iso(-3 * DAY),
    lastSeenAt: iso(-MIN),
    lastPostflightAt: iso(-MIN),
    bundleVersion: 3,
    bundleDigest: "a".repeat(64),
    catalogueVersion: "2026-10-16",
    ca: { fingerprintSha256: "abcdef0123456789".repeat(4), subject: "CN=Vibtra Guard adas-mbp", notAfter: iso(365 * DAY) },
    health: { caTrusted: true, proxyListening: true },
    quiet: false,
    eventsLast24h: 42,
    ...over,
  });

export const unprotected = (reason: GuardInterceptionOffReason, over: Partial<GuardDeviceRow> = {}): GuardDeviceRow =>
  deviceRow({ ca: undefined, health: { proxyListening: true, interception: { on: false, reason } }, ...over });

export const devices = (): GuardDevicesPage =>
  GuardDevicesPage.parse({
    rows: [
      deviceRow(),
      deviceRow({ deviceId: DEVICE_ID_2, hostname: "graces-air", person: GRACE, lastSeenAt: iso(-30 * HOUR), quiet: true, quietForMinutes: 30 * 60, health: { caTrusted: false }, eventsLast24h: 0 }),
    ],
    quietAfterMinutes: 1440,
    serverUrl: "http://127.0.0.1:4800",
  });

export const enrolLinks = (): GuardEnrolLinksPage =>
  GuardEnrolLinksPage.parse({ rows: [{ tokenPrefix: "0a1b2c3d", personEmail: GRACE.email, createdBy: ADA.email, createdAt: iso(-HOUR), expiresAt: iso(23 * HOUR) }] });

export const FAKE_ENROL_TOKEN = `genr_${"0f".repeat(16)}`;

export const enrolLink = (): GuardEnrolLink =>
  GuardEnrolLink.parse({
    token: FAKE_ENROL_TOKEN,
    url: `vibtra-guard://enrol?server=${encodeURIComponent("http://127.0.0.1:4800")}&token=${FAKE_ENROL_TOKEN}`,
    command: `vibtra-guard enrol --server http://127.0.0.1:4800 --token ${FAKE_ENROL_TOKEN}`,
    personEmail: GRACE.email,
    expiresAt: iso(24 * HOUR),
  });

export const services = (): GuardServicesPage => {
  const catalogue = seedCatalogue();
  return GuardServicesPage.parse({
    rows: catalogue.services
      .slice(0, 4)
      .map((s, i) => ({ ...s, people30d: 3 - Math.min(i, 3), devices30d: 2, events30d: 10 * (i + 1) }))
      .concat([
        { serviceId: "custom-acme-ai", name: "Acme AI", vendor: "Acme", category: "chat", domains: ["ai.acme.example"], bundleIds: [], cliNames: ["acme"], custom: true, enabled: true, defaultAction: "block", people30d: 0, devices30d: 0, events30d: 0 },
      ]),
    catalogueVersion: `${catalogue.version}+org.1`,
    seedVersion: catalogue.version,
  });
};

export const settings = (over: Partial<GuardSettingsPage["settings"]> = {}): GuardSettingsPage =>
  GuardSettingsPage.parse({
    settings: { ...defaultGuardSettings(), ...over },
    signingKeyId: "gk_0123abcd",
    staffNoticeRendered: GUARD_STAFF_NOTICE_TEMPLATE.replace(/\{\{orgName\}\}/g, "Fernwood"),
    org: { orgId: "org_fernwood", name: "Fernwood", handle: "fernwood", domain: "fernwood.example" },
    devices: 2,
  });

export const session = (role: "admin" | "member" = "admin"): ConsoleSession =>
  ConsoleSession.parse({
    email: ADA.email,
    issuer: "https://accounts.google.com",
    orgId: "org_fernwood",
    orgName: "Fernwood",
    handle: "fernwood",
    role,
    usage: { plan: "team", users: 2, userLimit: null },
  });

export const people = (): ConsolePeoplePage =>
  ConsolePeoplePage.parse({
    rows: [
      { issuer: "x", subject: ADA.userId, email: ADA.email, name: ADA.name, role: "admin", createdAt: iso(-90 * DAY), isYou: true },
      { issuer: "x", subject: GRACE.userId, email: GRACE.email, name: GRACE.name, role: "member", createdAt: iso(-30 * DAY) },
    ],
    total: 2,
  });

const askSubject = { serviceId: "openai-chatgpt", serviceName: "ChatGPT", ruleId: "gcr_0000aaaa", ruleName: "Tax file numbers", matchType: "au-tfn", deviceId: DEVICE_ID_2, hostname: "graces-air", app: "Google Chrome" };

export const policyRequests = (): ConsolePolicyRequestsPage =>
  ConsolePolicyRequestsPage.parse({
    requests: [
      {
        id: "preq_guard_1",
        orgId: "org_fernwood",
        requesterUserId: GRACE.userId,
        kind: "guard",
        subject: askSubject,
        subjectKey: `openai-chatgpt/gcr_0000aaaa@${GRACE.userId}`,
        words: 'sending what the rule "Tax file numbers" blocks to ChatGPT',
        status: "pending",
        reminderAt: iso(7 * DAY),
        expiresAt: iso(14 * DAY),
        createdAt: iso(-HOUR),
      },
    ],
  });

export const policyGrants = (): ConsolePolicyGrantsPage =>
  ConsolePolicyGrantsPage.parse({
    grants: [
      { id: "pgr_guard_1", orgId: "org_fernwood", scope: "user", userId: GRACE.userId, kind: "guard", subject: askSubject, subjectKey: `openai-chatgpt/gcr_0000aaaa@${GRACE.userId}`, expiresAt: iso(6 * DAY), requestId: "preq_guard_0", approvedBy: ADA.userId, createdAt: iso(-DAY), live: true },
      { id: "pgr_host_1", orgId: "org_fernwood", scope: "user", userId: GRACE.userId, kind: "egress-host", subject: {}, subjectKey: "api.example:443", requestId: "preq_x", approvedBy: ADA.userId, createdAt: iso(-DAY), live: true },
    ],
  });
