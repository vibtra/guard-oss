import { CONSOLE_API_PREFIX, CSRF_COOKIE, CSRF_HEADER, ConsoleSession, ORG_HANDLE_HEADER } from "@vibtra/console-api";
import {
  GUARD_API_PREFIX,
  GUARD_PROTOCOL_VERSION,
  GuardAskResponse,
  type GuardAskBody,
  type GuardCaFacts,
  type GuardDeviceFacts,
  GuardEnrolLink,
  GuardEnrolResponse,
  type GuardEvent,
  GuardEventUploadResponse,
  GuardPostflightResponse,
  GuardPreflightResponse,
  type GuardPreflightRequest,
} from "@vibtra/guard-contract";
import { REGISTRY_URL } from "./env.ts";

export const SESSION_COOKIE = "better-auth.session_token";

export interface Schema<T> {
  parse: (value: unknown) => T;
}

export interface Account {
  email: string;
  name: string;
  sessionToken: string;
}

export class RegistryRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: ${status} ${body.slice(0, 400)}`);
    this.name = "RegistryRefusal";
  }
}

const cookieFrom = (res: Response, name: string): string | undefined =>
  res.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

const jsonOf = async (res: Response, what: string): Promise<unknown> => {
  const text = await res.text();
  if (!res.ok) throw new RegistryRefusal(res.status, text, what);
  return text === "" ? undefined : JSON.parse(text);
};

export const signUp = async (person: { email: string; name: string }): Promise<Account> => {
  const res = await fetch(`${REGISTRY_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: REGISTRY_URL },
    body: JSON.stringify({ email: person.email, password: `e2e-console-passphrase-${person.email}`, name: person.name }),
  });
  const sessionToken = cookieFrom(res, SESSION_COOKIE);
  if (!res.ok || sessionToken === undefined) throw new RegistryRefusal(res.status, await res.text(), `sign up ${person.email}`);
  return { ...person, sessionToken };
};

export class ConsoleClient {
  private constructor(
    readonly account: Account,
    readonly session: ConsoleSession,
    readonly csrf: string,
  ) {}

  static async open(account: Account): Promise<ConsoleClient> {
    const res = await fetch(`${REGISTRY_URL}${CONSOLE_API_PREFIX}/session`, {
      headers: { accept: "application/json", cookie: `${SESSION_COOKIE}=${account.sessionToken}` },
    });
    const csrf = cookieFrom(res, CSRF_COOKIE);
    const session = ConsoleSession.parse(await jsonOf(res, `console session for ${account.email}`));
    if (csrf === undefined) throw new Error(`the console session for ${account.email} set no ${CSRF_COOKIE} cookie`);
    return new ConsoleClient(account, session, csrf);
  }

  get cookie(): string {
    return `${SESSION_COOKIE}=${this.account.sessionToken}; ${CSRF_COOKIE}=${this.csrf}`;
  }

  async read<T>(schema: Schema<T>, path: string): Promise<T> {
    const res = await fetch(`${REGISTRY_URL}${CONSOLE_API_PREFIX}${path}`, {
      headers: { accept: "application/json", cookie: this.cookie, [ORG_HANDLE_HEADER]: this.session.handle },
    });
    return schema.parse(await jsonOf(res, `GET ${path} as ${this.account.email}`));
  }

  async write<T>(schema: Schema<T>, method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${REGISTRY_URL}${CONSOLE_API_PREFIX}${path}`, {
      method,
      headers: {
        accept: "application/json",
        cookie: this.cookie,
        origin: REGISTRY_URL,
        [CSRF_HEADER]: this.csrf,
        [ORG_HANDLE_HEADER]: this.session.handle,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return schema.parse(await jsonOf(res, `${method} ${path} as ${this.account.email}`));
  }
}

const hex = (seed: string, length: number): string => {
  let out = "";
  for (let i = 0; out.length < length; i += 1) out += ((seed.charCodeAt(i % seed.length) * 31 + i * 7) % 256).toString(16).padStart(2, "0");
  return out.slice(0, length);
};

export const deviceFacts = (hostname: string, primaryUser: string): GuardDeviceFacts => ({
  hostname,
  serialNumber: `C02E2E${hex(hostname, 6).toUpperCase()}`,
  modelIdentifier: "Mac15,3",
  osVersion: "26.0",
  agentVersion: "0.1.0",
  arch: "arm64",
  primaryUser,
});

export const caFacts = (hostname: string): GuardCaFacts => ({
  fingerprintSha256: hex(`ca-${hostname}`, 64),
  subject: `CN=Vibtra Guard ${hostname}`,
  notAfter: "2036-10-16T00:00:00.000Z",
});

let eventSeq = 0;
export const eventId = (): string => `gev_${(0xe2e00000 + (eventSeq += 1)).toString(16).padStart(16, "0")}`;

export class AgentClient {
  constructor(
    readonly deviceId: string,
    readonly deviceToken: string,
    readonly facts: GuardDeviceFacts,
    readonly ca: GuardCaFacts,
  ) {}

  private async post<T>(schema: Schema<T>, door: string, body: unknown): Promise<T> {
    const res = await fetch(`${REGISTRY_URL}${GUARD_API_PREFIX}/${door}/${this.deviceId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.deviceToken}` },
      body: JSON.stringify(body),
    });
    return schema.parse(await jsonOf(res, `${door} for ${this.facts.hostname}`));
  }

  async checkIn(health: NonNullable<GuardPreflightRequest["health"]>): Promise<GuardPreflightResponse> {
    const preflight = await this.post(GuardPreflightResponse, "preflight", {
      protocol: GUARD_PROTOCOL_VERSION,
      device: this.facts,
      ca: this.ca,
      clientMode: "monitor",
      pendingEvents: 0,
      health,
    });
    await this.post(GuardPostflightResponse, "postflight", {
      protocol: GUARD_PROTOCOL_VERSION,
      bundleVersion: preflight.bundleVersion,
      catalogueVersion: preflight.catalogueVersion,
      rulesReceived: 0,
      rulesProcessed: 0,
      clientMode: preflight.clientMode,
    });
    return preflight;
  }

  upload(events: GuardEvent[]): Promise<GuardEventUploadResponse> {
    return this.post(GuardEventUploadResponse, "eventupload", { protocol: GUARD_PROTOCOL_VERSION, events });
  }

  ask(body: GuardAskBody): Promise<GuardAskResponse> {
    return this.post(GuardAskResponse, "requests", body);
  }
}

export const enrolDevice = async (admin: ConsoleClient, person: { email: string; name: string }, hostname: string): Promise<AgentClient> => {
  const link = await admin.write(GuardEnrolLink, "POST", "/guard/devices/enrol-links", { personEmail: person.email, note: `${person.name}'s laptop` });
  const facts = deviceFacts(hostname, person.email.split("@")[0] ?? "user");
  const ca = caFacts(hostname);
  const res = await fetch(`${REGISTRY_URL}${GUARD_API_PREFIX}/enrol`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.token, device: facts, ca }),
  });
  const enrolled = GuardEnrolResponse.parse(await jsonOf(res, `enrol ${hostname}`));
  return new AgentClient(enrolled.deviceId, enrolled.deviceToken, facts, ca);
};
