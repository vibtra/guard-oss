import type { LightMyRequestResponse } from "fastify";
import { GUARD_API_PREFIX, GUARD_PROTOCOL_VERSION, type GuardEnrolResponse } from "@vibtra/guard-contract";
import type { RegistryServer } from "../src/server.js";
import { consoleGet, consoleSession, consoleWrite, jsonOf } from "./helpers/console.js";
import { orgIdOf, signIn, startHostedRegistry, userIdOf } from "./helpers/hosted.js";

export const ORIGIN = "http://registry.test.local";
export const CA = { fingerprintSha256: "ab".repeat(32), subject: "CN=Vibtra Guard local CA", notAfter: "2036-10-16T00:00:00.000Z" } as const;
export const facts = (hostname: string) => ({ hostname, osVersion: "26.0", agentVersion: "0.1.0", arch: "arm64" as const, primaryUser: hostname.split("-")[0] ?? "user" });

export interface Person {
  name: string;
  email: string;
  cookie: string;
  userId: string;
}

export const startGuardBed = async (domain = "acme.example", overrides: Parameters<typeof startHostedRegistry>[0] = {}) => {
  const { registry } = await startHostedRegistry(overrides);
  const people: Record<string, Person> = {};
  const join = async (name: string) => {
    const email = `${name}@${domain}`;
    const cookie = await signIn(registry, { sub: `${name}-${domain}`, email });
    people[name] = { name, email, cookie, userId: (await userIdOf(registry, `${name}-${domain}`))! };
    return people[name]!;
  };
  const ada = await join("ada");
  const orgId = (await orgIdOf(registry, `ada-${domain}`))!;
  const bo = await join("bo");
  const cy = await join("cy");
  const dee = await join("dee");
  const promoted = await consoleWrite(registry, "POST", `/people/${bo.userId}/role`, await consoleSession(registry, ada.cookie), { role: "admin" });
  if (promoted.statusCode !== 200) throw new Error(`promote: ${promoted.statusCode} ${promoted.body}`);
  const made = await consoleWrite(registry, "POST", "/groups", await consoleSession(registry, ada.cookie), { name: "Finance" });
  const financeId = (jsonOf<{ row: { id: string } }>(made)).row.id;
  const added = await consoleWrite(registry, "POST", `/groups/${financeId}/members`, await consoleSession(registry, ada.cookie), { email: cy.email });
  if (added.statusCode >= 300) throw new Error(`group member: ${added.statusCode} ${added.body}`);
  return { registry, orgId, people: { ada, bo, cy, dee }, financeId, join };
};

export const write = async (registry: RegistryServer, who: Person, method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => {
  const res = await consoleWrite(registry, method, path, await consoleSession(registry, who.cookie), body);
  return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as Record<string, any>) : {}, res };
};
export const read = async (registry: RegistryServer, who: Person, path: string) => {
  const res = await consoleGet(registry, path, who.cookie);
  return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as Record<string, any>) : {}, res };
};

export const sync = async (registry: RegistryServer, method: "GET" | "POST", path: string, token: string | undefined, body?: unknown): Promise<{ status: number; json: Record<string, any>; res: LightMyRequestResponse }> => {
  const res = await registry.app.inject({
    method,
    url: `${GUARD_API_PREFIX}${path}`,
    headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as Record<string, any>) : {}, res };
};

export const enrolDevice = async (registry: RegistryServer, admin: Person, person: Person, hostname: string) => {
  const link = await write(registry, admin, "POST", "/guard/devices/enrol-links", { personEmail: person.email });
  if (link.status !== 201) throw new Error(`enrol link: ${link.status} ${JSON.stringify(link.json)}`);
  const enrolled = await sync(registry, "POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.json.token, device: facts(hostname), ca: CA });
  if (enrolled.status !== 201) throw new Error(`enrol: ${enrolled.status} ${JSON.stringify(enrolled.json)}`);
  return { enrol: enrolled.json as GuardEnrolResponse, link: link.json as { token: string; url: string; command: string } };
};

export const preflightBody = (hostname: string, extra: Record<string, unknown> = {}) => ({ protocol: GUARD_PROTOCOL_VERSION, device: facts(hostname), ca: CA, clientMode: "monitor", pendingEvents: 0, ...extra });

let seq = 0;
export const eventId = (): string => `gev_${(0xe0000000 + (seq += 1)).toString(16).padStart(16, "0")}`;
