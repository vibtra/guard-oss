import { ConsolePolicyDecided } from "@vibtra/console-api";
import { GUARD_API_PREFIX, GUARD_PROTOCOL_VERSION, GuardEnrolLink, GuardEnrolResponse, type GuardCaFacts, type GuardDeviceFacts } from "@vibtra/guard-contract";
import type { Person, TestRegistry } from "../../support/registry.ts";

export const CA: GuardCaFacts = { fingerprintSha256: "ab".repeat(32), subject: "CN=Example Guard test CA", notAfter: "2036-10-16T00:00:00.000Z" };

export const facts = (hostname: string, extra: Partial<GuardDeviceFacts> = {}): GuardDeviceFacts => ({
  hostname,
  osVersion: "26.0",
  agentVersion: "0.1.0",
  arch: "arm64",
  primaryUser: hostname.split("-")[0] ?? "user",
  ...extra,
});

export const preflightBody = (hostname: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: GUARD_PROTOCOL_VERSION,
  device: facts(hostname),
  ca: CA,
  clientMode: "monitor",
  pendingEvents: 0,
  ...extra,
});

export interface Page {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

export const page = async (url: string, init: RequestInit = {}): Promise<Page> => {
  const response = await fetch(url, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
};

export interface DoorReply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

const parsed = (text: string): unknown => {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const agentDoor = async (registry: TestRegistry, method: "GET" | "POST", doorPath: string, token?: string, body?: unknown): Promise<DoorReply> => {
  const response = await fetch(`${registry.url}${GUARD_API_PREFIX}${doorPath}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: parsed(text) };
};

export interface EnrolledDevice {
  readonly deviceId: string;
  readonly token: string;
  readonly enrol: GuardEnrolResponse;
  readonly link: GuardEnrolLink;
}

export const mintEnrolLink = async (registry: TestRegistry, admin: Person, person: Person, extra: Record<string, unknown> = {}): Promise<GuardEnrolLink> => {
  const minted = await registry.consoleWrite(admin, "POST", "/guard/devices/enrol-links", { personEmail: person.email, ...extra });
  if (minted.status !== 201) throw new Error(`the enrol link for ${person.email} answered ${minted.status}: ${minted.text.slice(0, 300)}`);
  return GuardEnrolLink.parse(minted.body);
};

export const enrolDevice = async (registry: TestRegistry, admin: Person, person: Person, hostname: string, device: GuardDeviceFacts = facts(hostname)): Promise<EnrolledDevice> => {
  const link = await mintEnrolLink(registry, admin, person);
  const enrolled = await agentDoor(registry, "POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.token, device, ca: CA });
  if (enrolled.status !== 201) throw new Error(`enrolling ${hostname} answered ${enrolled.status}: ${enrolled.text.slice(0, 300)}`);
  const enrol = GuardEnrolResponse.parse(enrolled.body);
  return { deviceId: enrol.deviceId, token: enrol.deviceToken, enrol, link };
};

let sequence = 0;

export const eventId = (): string => `gev_${(0xe0000000 + (sequence += 1)).toString(16).padStart(16, "0")}`;

export const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
};

export const grantOf = (approval: unknown): Record<string, unknown> & { readonly id: string } => {
  const grant = ConsolePolicyDecided.parse(approval).grant;
  const id = grant?.id;
  if (grant === undefined || typeof id !== "string") throw new Error("the approval carries no grant");
  return { ...grant, id };
};
