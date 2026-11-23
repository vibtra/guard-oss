import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_ADMIN_ONLY_CODE, ConsoleGroupDetail, CSRF_HEADER } from "@vibtra/console-api";
import type { AccessLevel } from "@vibtra/registry/src/auth/access.ts";
import { REGISTRY_ORIGIN, startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, grantOf, type EnrolledDevice } from "./guard-device.ts";

type Json = Record<string, any>;

const ACCESS: Record<AccessLevel, readonly string[]> = {
  public: [
    "DELETE /scim/v2/Groups",
    "DELETE /scim/v2/Groups/:id",
    "DELETE /scim/v2/Users/:id",
    "GET /",
    "GET /:handle/guard",
    "GET /:handle/guard/*",
    "GET /api/auth/*",
    "GET /api/onboarding/invitations",
    "GET /assets/guard/*",
    "GET /guard/download/:token",
    "GET /guard/enrol",
    "GET /guard/enrol/:token",
    "GET /healthz",
    "GET /landing",
    "GET /landing/",
    "GET /login",
    "GET /pricing",
    "GET /privacy",
    "GET /scim/v2/Groups",
    "GET /scim/v2/Groups/:id",
    "GET /scim/v2/ServiceProviderConfig",
    "GET /scim/v2/Users",
    "GET /scim/v2/Users/:id",
    "GET /signin",
    "GET /start",
    "GET /terms",
    "PATCH /scim/v2/Groups",
    "PATCH /scim/v2/Groups/:id",
    "PATCH /scim/v2/Users/:id",
    "POST /api/auth/*",
    "POST /api/console/invitations/:invitationId/accept",
    "POST /api/guard/v1/enrol",
    "POST /guard/enrol",
    "POST /guard/enrol/:token",
    "POST /scim/v2/Groups",
    "POST /scim/v2/Groups/:id",
    "POST /scim/v2/Users",
    "PUT /scim/v2/Groups",
    "PUT /scim/v2/Groups/:id",
  ],
  device: [
    "GET /api/guard/v1/requests/:deviceId",
    "GET /api/guard/v1/signing/:deviceId",
    "GET /api/guard/v1/sync/wait/:deviceId",
    "POST /api/guard/v1/eventupload/:deviceId",
    "POST /api/guard/v1/postflight/:deviceId",
    "POST /api/guard/v1/preflight/:deviceId",
    "POST /api/guard/v1/requests/:deviceId",
    "POST /api/guard/v1/ruledownload/:deviceId",
  ],
  member: [
    "GET /api/console/groups",
    "GET /api/console/me/groups",
    "GET /api/console/people",
    "GET /api/console/people/onboarding/settings",
    "GET /api/console/policy-requests/mine",
    "GET /api/console/session",
    "POST /api/console/account/close",
  ],
  admin: [
    "DELETE /api/console/groups/:id",
    "DELETE /api/console/groups/:id/members/:email",
    "DELETE /api/console/guard/services/:id",
    "DELETE /api/console/people/:userId",
    "DELETE /api/console/people/invitations/:invitationId",
    "GET /api/console/guard/activity",
    "GET /api/console/guard/devices",
    "GET /api/console/guard/devices/enrol-links",
    "GET /api/console/guard/overview",
    "GET /api/console/guard/rules",
    "GET /api/console/guard/services",
    "GET /api/console/guard/settings",
    "GET /api/console/people/onboarding",
    "GET /api/console/people/protection",
    "GET /api/console/people/protection/rollout",
    "GET /api/console/policy-grants",
    "GET /api/console/policy-requests",
    "GET /api/console/policy-requests/:id",
    "GET /api/console/registration",
    "GET /api/console/sso",
    "PATCH /api/console/groups/:id",
    "POST /api/console/groups",
    "POST /api/console/groups/:id/members",
    "POST /api/console/guard/devices/:id/revoke",
    "POST /api/console/guard/devices/enrol-links",
    "POST /api/console/guard/rules/test",
    "POST /api/console/guard/services",
    "POST /api/console/people/:userId/onboarding/remind",
    "POST /api/console/people/:userId/role",
    "POST /api/console/people/:userId/sessions/revoke",
    "POST /api/console/people/invitations",
    "POST /api/console/people/invitations/:invitationId/resend",
    "POST /api/console/people/protection/apply",
    "POST /api/console/people/protection/preview",
    "POST /api/console/policy-grants/:id/revoke",
    "POST /api/console/policy-requests/:id/approve",
    "POST /api/console/policy-requests/:id/decline",
    "PUT /api/console/guard/rules",
    "PUT /api/console/guard/services/:id",
    "PUT /api/console/guard/settings",
    "PUT /api/console/people/onboarding/settings",
  ],
  owner: [
    "DELETE /api/console/registration/allowlist/:id",
    "DELETE /api/console/sso/:providerId",
    "POST /api/console/org/name",
    "POST /api/console/registration/allowlist",
    "POST /api/console/registration/waitlist/:id/admit",
    "POST /api/console/sso",
    "POST /api/console/sso/:providerId/test",
    "POST /api/console/sso/domains",
  ],
};

type CallerName = "nobody" | "device" | "member" | "admin" | "outsider" | "outsiderDevice";

interface Caller {
  readonly name: CallerName;
  readonly outsideOrgA: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

interface Refusal {
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
}

const SIGN_IN: Refusal = { status: 401, code: "DEPLOY_AUTH_EXPIRED" };
const DEVICE_TOKEN: Refusal = { status: 401, code: "GUARD_TOKEN_INVALID" };
const ADMINS_ONLY: Refusal = { status: 403, code: CONSOLE_ADMIN_ONLY_CODE };
const OWNERS_ONLY: Refusal = { status: 403, message: "Owners only" };

const REFUSALS: Record<AccessLevel, Partial<Record<CallerName, Refusal>>> = {
  public: {},
  device: { nobody: DEVICE_TOKEN, member: DEVICE_TOKEN, outsider: DEVICE_TOKEN, outsiderDevice: DEVICE_TOKEN },
  member: { nobody: SIGN_IN, device: SIGN_IN, outsiderDevice: SIGN_IN },
  admin: { nobody: SIGN_IN, device: SIGN_IN, outsiderDevice: SIGN_IN, member: ADMINS_ONLY },
  owner: { nobody: SIGN_IN, device: SIGN_IN, outsiderDevice: SIGN_IN, member: ADMINS_ONLY, admin: OWNERS_ONLY },
};

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Json | undefined;
}

interface OrgA {
  readonly orgId: string;
  readonly handle: string;
  readonly userIds: readonly string[];
  readonly adminUserId: string;
  readonly memberEmail: string;
  readonly laptop: EnrolledDevice;
  readonly requestId: string;
  readonly grantId: string;
  readonly serviceId: string;
  readonly groupId: string;
  readonly invitationId: string;
}

const DOMAIN_A = "route-access.example";

let registry: TestRegistry;
let a: OrgA;
let outsiderLaptop: EnrolledDevice;
let callers: readonly Caller[];

const parsed = (text: string): Json | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
};

const call = async (method: string, path: string, caller: Caller): Promise<Reply> => {
  const writes = method !== "GET" && method !== "DELETE";
  const response = await fetch(`${registry.url}${path}`, {
    method,
    redirect: "manual",
    headers: { origin: REGISTRY_ORIGIN, ...caller.headers, ...(writes ? { "content-type": "application/json" } : {}) },
    ...(writes ? { body: "{}" } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, body: parsed(text) };
};

const outsideGuard = (reply: Reply): boolean => reply.status === 404 && reply.body?.error === "Not part of Guard";

const refusedAs = (reply: Reply, refusal: Refusal): boolean =>
  outsideGuard(reply) ||
  (reply.status === refusal.status &&
    (refusal.code === undefined || reply.body?.code === refusal.code) &&
    (refusal.message === undefined || reply.body?.message === refusal.message));

const required = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

const routeKey = (route: { method: string; url: string }): string => `${route.method} ${route.url}`;

const registered = () => registry.server.routes().filter((route) => route.method !== "HEAD");

interface Probe {
  readonly key: string;
  readonly level: AccessLevel;
  readonly method: string;
  readonly path: string;
  readonly namesOrgA: boolean;
}

const probes = (): Probe[] => {
  const idAfter: Record<string, string> = {
    "policy-requests": a.requestId,
    "policy-grants": a.grantId,
    devices: a.laptop.deviceId,
    services: a.serviceId,
    groups: a.groupId,
    waitlist: a.orgId,
    allowlist: "probe-allowlist-row",
    Users: a.adminUserId,
    Groups: a.groupId,
  };
  const byName: Record<string, string> = {
    deviceId: a.laptop.deviceId,
    userId: a.adminUserId,
    invitationId: a.invitationId,
    email: a.memberEmail,
    providerId: "probe-provider",
    token: "probe-token",
    handle: a.handle,
  };
  const wildcard: Record<string, string> = { "/api/auth/*": "ok", "/assets/guard/*": "probe.js", "/:handle/guard/*": "rules" };
  const orgAValues = new Set(Object.values({ ...idAfter, ...byName }).filter((value) => !value.startsWith("probe-")));
  return registered().map((route) => {
    let namesOrgA = false;
    const path = route.url.replace(/:(\w+)|\*/g, (match: string, name: string | undefined, offset: number) => {
      const segment = route.url.slice(0, offset).split("/").at(-2) ?? "";
      const value = name === undefined ? wildcard[route.url] : name === "id" ? idAfter[segment] : byName[name];
      if (value === undefined) throw new Error(`route-access.test.ts names no org A value for ${match} in ${routeKey(route)}: add one`);
      namesOrgA ||= orgAValues.has(value);
      return encodeURIComponent(value);
    });
    const level = Object.entries(ACCESS).find(([, keys]) => keys.includes(routeKey(route)))?.[0] as AccessLevel | undefined;
    return { key: routeKey(route), level: level ?? required(route.access), method: route.method, path, namesOrgA };
  });
};

const orgAMarkers = (): string[] => [
  DOMAIN_A,
  a.orgId,
  ...a.userIds,
  a.laptop.deviceId,
  a.requestId,
  a.grantId,
  a.serviceId,
  a.groupId,
  a.invitationId,
];

const created = <T,>(reply: { status: number; text: string }, what: string, read: () => T): T => {
  if (reply.status >= 300) throw new Error(`${what} answered ${reply.status}: ${reply.text.slice(0, 300)}`);
  return read();
};

const ask = async (laptop: EnrolledDevice, serviceId: string): Promise<string> => {
  const asked = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId });
  return created(asked, `asking for ${serviceId}`, () => String((asked.body as Json).request.requestId));
};

const session = (name: CallerName, person: Person): Caller => ({
  name,
  outsideOrgA: name === "outsider",
  headers: { cookie: person.cookie, [CSRF_HEADER]: person.csrf },
});

const bearer = (name: CallerName, laptop: EnrolledDevice): Caller => ({
  name,
  outsideOrgA: name === "outsiderDevice",
  headers: { authorization: `Bearer ${laptop.token}` },
});

beforeAll(async () => {
  registry = await startRegistry({ domain: DOMAIN_A });
  const { owner, admin, member } = registry.people;
  const sessionPage = (await registry.consoleGet(owner, "/session")).body as Json;
  const laptop = await enrolDevice(registry, admin, member, "member-mac");
  const requestId = await ask(laptop, "deepseek");
  const approved = await registry.consoleWrite(admin, "POST", `/policy-requests/${await ask(laptop, "mistral")}/approve`, {});
  const grantId = created(approved, "approving the mistral ask", () => grantOf(approved.body).id);
  const service = await registry.consoleWrite(admin, "POST", "/guard/services", {
    slug: "route-access-gpt",
    name: "Route Access GPT",
    vendor: "Example",
    category: "chat",
    domains: ["gpt.route-access-internal.example"],
    bundleIds: [],
    cliNames: [],
    defaultAction: "block",
  });
  const serviceId = created(service, "adding a custom service", () => String((service.body as Json).serviceId));
  const group = await registry.consoleWrite(admin, "POST", "/groups", { name: "Route access" });
  const groupId = created(group, "creating a group", () => ConsoleGroupDetail.parse(group.body).row.id);
  const joined = await registry.consoleWrite(admin, "POST", `/groups/${groupId}/members`, { email: member.email });
  created(joined, "adding the member to the group", () => undefined);
  const invited = await registry.consoleWrite(admin, "POST", "/people/invitations", { email: `invitee@${DOMAIN_A}`, role: "member" });
  const invitationId = created(invited, "inviting somebody", () => String((invited.body as Json).invitationId));
  a = {
    orgId: String(sessionPage.orgId),
    handle: String(sessionPage.handle),
    userIds: [owner.userId, admin.userId, member.userId],
    adminUserId: admin.userId,
    memberEmail: member.email,
    laptop,
    requestId,
    grantId,
    serviceId,
    groupId,
    invitationId,
  };

  const outsider = await registry.join("outsider", "outsider.example");
  outsiderLaptop = await enrolDevice(registry, outsider, outsider, "outsider-mac");
  callers = [
    { name: "nobody", outsideOrgA: true, headers: {} },
    bearer("device", laptop),
    session("member", member),
    session("admin", admin),
    session("outsider", outsider),
    bearer("outsiderDevice", outsiderLaptop),
  ];
});

afterAll(async () => {
  await registry?.close();
});

describe("every registered registry route", () => {
  it("declares the access level this table pins", () => {
    const declared: Record<AccessLevel, string[]> = { public: [], device: [], member: [], admin: [], owner: [] };
    for (const route of registered()) declared[required(route.access)].push(routeKey(route));
    for (const keys of Object.values(declared)) keys.sort();
    expect(declared).toEqual(ACCESS);
  });

  it("answers each caller its declared level does not admit with that level's refusal", async () => {
    const credentials = await Promise.all([
      registry.consoleGet(registry.people.member, "/session"),
      registry.consoleGet(registry.people.admin, "/session"),
      agentDoor(registry, "GET", `/signing/${a.laptop.deviceId}`, a.laptop.token),
      agentDoor(registry, "GET", `/signing/${outsiderLaptop.deviceId}`, outsiderLaptop.token),
    ]);
    expect(credentials.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);

    const wrong: string[] = [];
    for (const probe of probes()) {
      for (const caller of callers) {
        const refusal = REFUSALS[probe.level][caller.name];
        if (refusal === undefined) continue;
        const reply = await call(probe.method, probe.path, caller);
        if (!refusedAs(reply, refusal)) wrong.push(`${probe.key} (${probe.level}) as ${caller.name}: ${reply.status} ${reply.text.slice(0, 160)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never shows a caller from outside org A what org A holds, refuses an outsider each org A resource, and leaves them as they were", async () => {
    const outsider = callers.find((caller) => caller.name === "outsider");
    expect((await call("GET", "/api/console/session", required(outsider))).body?.orgId).not.toBe(a.orgId);

    const wrong: string[] = [];
    for (const probe of probes()) {
      const markers = orgAMarkers().filter((marker) => !decodeURIComponent(probe.path).includes(marker));
      for (const caller of callers.filter((each) => each.outsideOrgA)) {
        const reply = await call(probe.method, probe.path, caller);
        const leaked = markers.filter((marker) => reply.text.includes(marker));
        if (leaked.length > 0) wrong.push(`${probe.key} as ${caller.name} showed ${leaked.join(", ")}`);
        const reachesOrgA = caller.name === "outsider" && probe.namesOrgA && ["member", "admin", "owner"].includes(probe.level);
        if (reachesOrgA && ![403, 404].includes(reply.status)) wrong.push(`${probe.key} as ${caller.name}: ${reply.status} ${reply.text.slice(0, 160)}`);
      }
    }
    expect(wrong).toEqual([]);

    const admin = registry.people.admin;
    expect(((await registry.consoleGet(admin, `/policy-requests/${a.requestId}`)).body as Json).request).toMatchObject({ id: a.requestId, status: "pending" });
    expect(((await registry.consoleGet(admin, "/policy-grants")).body as Json).grants).toContainEqual(expect.objectContaining({ id: a.grantId, live: true }));
    expect(((await registry.consoleGet(admin, "/guard/devices")).body as Json).rows).toContainEqual(expect.objectContaining({ deviceId: a.laptop.deviceId, status: "active" }));
    expect(((await registry.consoleGet(admin, "/guard/services")).body as Json).rows).toContainEqual(expect.objectContaining({ serviceId: a.serviceId }));
    expect(((await registry.consoleGet(admin, "/groups")).body as Json).rows).toContainEqual(expect.objectContaining({ id: a.groupId, memberCount: 1 }));
  });
});
