import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailAdapter, MailMessage } from "@vibtra/registry/src/mail/mailer.ts";
import { SESSION_COOKIE_NAME } from "@vibtra/registry/src/auth/better-auth.ts";
import { REGISTRY_ORIGIN, startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { manualClock, withHosted } from "./server-options.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DOWNLOAD = "https://downloads.example/guard-1.0.pkg";

interface Listed {
  email: string;
  verified: boolean;
  invitations: Array<{ invitationId: string; orgName: string; invitedBy: string; expiresAt: string }>;
}

const outbox = (): { adapter: MailAdapter; sent: MailMessage[] } => {
  const sent: MailMessage[] = [];
  return { sent, adapter: { name: "smtp", create: () => ({ send: async (message) => (sent.push(message), true) }) } };
};

const linkIn = (text: string, path: string): string => {
  const match = new RegExp(`https?://[^\\s]+${path}/[A-Za-z0-9_.-]+`).exec(text);
  if (match === null) throw new Error(`no ${path} link in the email`);
  return match[0];
};

const sessionCookie = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";

const clock = manualClock(new Date("2026-11-18T09:00:00.000Z"));
const box = outbox();
let registry: TestRegistry;
let owner: Person;
let member: Person;

const signUp = async (email: string): Promise<{ userId: string; cookie: string }> => {
  const res = await fetch(`${registry.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
    body: JSON.stringify({ email, password: `vibtra-test-passphrase-${email}`, name: email.split("@")[0] }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return { userId: String(((await res.json()) as { user: { id: string } }).user.id), cookie: sessionCookie(res) };
};

const invite = async (by: Person, email: string): Promise<string> => {
  const invited = await registry.consoleWrite(by, "POST", "/people/invitations", { email, role: "member" });
  expect(invited.status, invited.text).toBe(200);
  return String((invited.body as { invitationId: string }).invitationId);
};

const orgNameOf = async (person: Person): Promise<string> => String(((await registry.consoleGet(person, "/session")).body as { orgName: string }).orgName);

const listed = (cookie?: string): Promise<Response> =>
  fetch(`${registry.url}/api/onboarding/invitations`, { headers: cookie === undefined ? {} : { cookie } });

const enrolLinkRows = async (): Promise<Array<{ personEmail: string; createdBy: string }>> =>
  ((await registry.consoleGet(owner, "/guard/devices/enrol-links")).body as { rows: Array<{ personEmail: string; createdBy: string }> }).rows;

const open = async (url: string, headers: Record<string, string> = {}): Promise<{ status: number; html: string }> => {
  const res = await fetch(url, { headers, redirect: "manual" });
  return { status: res.status, html: await res.text() };
};

const press = async (url: string, headers: Record<string, string> = {}): Promise<{ status: number; html: string }> => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: REGISTRY_ORIGIN, ...headers }, body: "" });
  return { status: res.status, html: await res.text() };
};

beforeAll(async () => {
  registry = await startRegistry({
    domain: "dead-ends.example",
    configure: (options) => ({
      ...withHosted((h) => ({ ...h, mailAdapter: "smtp", mailFrom: "IT <it@dead-ends.example>", guardDownloadUrl: DOWNLOAD }))(options),
      mailAdapters: [box.adapter],
      clock,
    }),
  });
  ({ owner, member } = registry.people);
});
afterAll(async () => registry?.close());

describe("a person who signs in without the invitation link", () => {
  it("is shown the live invitations for their verified address, with the organisation, who invited them and when each expires, and nobody else's", async () => {
    const ira = "ira@dead-ends.example";
    const bo = await registry.join("bo", "bo-org.example");
    const cy = await registry.join("cy", "cy-org.example");
    const ours = await invite(owner, ira);
    const theirs = await invite(bo, ira);
    const cancelled = await invite(cy, ira);
    expect((await registry.consoleWrite(cy, "DELETE", `/people/invitations/${cancelled}`)).status).toBe(204);
    const dee = await registry.join("dee", "dee-org.example");
    const lapsed = await invite(dee, ira);
    const adapter = await registry.server.auth!.adapter();
    await adapter.update({ model: "invitation", where: [{ field: "id", value: lapsed }], update: { expiresAt: new Date(Date.now() - 60_000) } });
    const someoneElse = await invite(owner, "noor@dead-ends.example");

    const { userId, cookie } = await signUp(ira);
    const res = await listed(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text) as Listed;
    expect(body.email).toBe(ira);
    expect(body.verified).toBe(true);
    const byId = new Map(body.invitations.map((row) => [row.invitationId, row]));
    expect([...byId.keys()].sort()).toEqual([ours, theirs].sort());
    expect(byId.get(ours)).toEqual({ invitationId: ours, orgName: await orgNameOf(owner), invitedBy: "owner", expiresAt: expect.any(String) });
    expect(byId.get(theirs)).toMatchObject({ orgName: await orgNameOf(bo), invitedBy: "bo" });
    expect(Date.parse(byId.get(ours)!.expiresAt)).toBeGreaterThan(Date.now());
    for (const hidden of [cancelled, lapsed, someoneElse, "noor@dead-ends.example", owner.email, member.email]) expect(text).not.toContain(hidden);

    await adapter.update({ model: "user", where: [{ field: "id", value: userId }], update: { emailVerified: false } });
    expect(await (await listed(cookie)).json()).toEqual({ email: ira, verified: false, invitations: [] });
    await adapter.update({ model: "user", where: [{ field: "id", value: userId }], update: { emailVerified: true } });
  });

  it("limits each person on each address with a JSON 429, without locking anybody else out", async () => {
    await invite(owner, "zoe@dead-ends.example");
    const zoe = await signUp("zoe@dead-ends.example");
    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) statuses.push((await listed(zoe.cookie)).status);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const refused = await listed(zoe.cookie);
    expect([refused.status, Number(refused.headers.get("retry-after")) > 0, refused.headers.get("content-type")]).toEqual([429, true, expect.stringMatching(/^application\/json/)]);
    expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    await invite(owner, "yan@dead-ends.example");
    expect((await listed((await signUp("yan@dead-ends.example")).cookie)).status).toBe(200);
  });

  it("answers 401 to somebody who is not signed in", async () => {
    const res = await listed();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a person who opens the invitation link signed in with another account", () => {
  it("is refused by Better Auth with the code the start page reads to say the invitation is for another address", async () => {
    const id = await invite(owner, "uma@dead-ends.example");
    const { cookie } = await signUp("val@dead-ends.example");
    const res = await fetch(`${registry.url}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN, cookie },
      body: JSON.stringify({ invitationId: id }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION");
  });

  it("gets Google's account chooser only when the sign-in asks for it, as the switch-account button does", async () => {
    const promptOf = async (extra: Record<string, unknown>): Promise<string | null> => {
      const res = await fetch(`${registry.url}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
        body: JSON.stringify({ provider: "google", callbackURL: `${REGISTRY_ORIGIN}/start?invitation=inv_1`, ...extra }),
      });
      expect(res.status).toBe(200);
      return new URL(String(((await res.json()) as { url?: unknown }).url)).searchParams.get("prompt");
    };
    expect(await promptOf({})).toBeNull();
    expect(await promptOf({ additionalParams: { prompt: "select_account" } })).toBe("select_account");
  });
});

describe("a member who opens Guard on the Mac with no enrol link", () => {
  const enrol = (): string => `${registry.url}/guard/enrol`;

  it("is asked to sign in, and comes back to this page afterwards", async () => {
    const page = await open(enrol(), { "user-agent": MAC });
    expect(page.status).toBe(200);
    expect(page.html).toContain(`/login?next=${encodeURIComponent("/guard/enrol")}`);
    expect(page.html).not.toContain("<form");
    const before = (await enrolLinkRows()).length;
    expect((await press(enrol())).status).toBe(401);
    expect(await enrolLinkRows()).toHaveLength(before);
  });

  it("makes an enrol link for their own address in their own organisation, from a form on this server only", async () => {
    const before = (await enrolLinkRows()).length;
    const page = await open(enrol(), { cookie: member.cookie, "user-agent": MAC });
    expect(page.status).toBe(200);
    expect(page.html).toContain("Make my enrol link");
    expect(page.html).toContain(member.email);
    const elsewhere: Array<Record<string, string>> = [{ origin: "https://elsewhere.example" }, { origin: "", "sec-fetch-site": "cross-site" }];
    for (const from of elsewhere) {
      const refused = await press(enrol(), { cookie: member.cookie, ...from });
      expect(refused.status, JSON.stringify(from)).toBe(403);
    }
    expect(await enrolLinkRows()).toHaveLength(before);

    const minted = await press(enrol(), { cookie: member.cookie, "user-agent": MAC });
    expect(minted.status, minted.html).toBe(200);
    expect(minted.html).toContain("vibtra-guard://enrol?server=");
    const rows = await enrolLinkRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ personEmail: member.email, createdBy: member.email });
  });

  it("names the organisation the link enrols into, and mints into that one, for a person in two organisations", async () => {
    const two = await registry.join("two", "dead-ends.example");
    const eli = await registry.join("eli", "eli-org.example");
    const accepted = await fetch(`${registry.url}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN, cookie: two.cookie },
      body: JSON.stringify({ invitationId: await invite(eli, two.email) }),
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const rowsIn = async (admin: Person): Promise<number> => ((await registry.consoleGet(admin, "/guard/devices/enrol-links")).body as { rows: unknown[] }).rows.length;
    const [ownerBefore, eliBefore] = [await rowsIn(owner), await rowsIn(eli)];
    const sessionOrg = String(((await registry.consoleGet(two, "/session")).body as { orgName: string }).orgName);
    const otherOrg = sessionOrg === (await orgNameOf(owner)) ? await orgNameOf(eli) : await orgNameOf(owner);

    const page = await open(enrol(), { cookie: two.cookie, "user-agent": MAC });
    expect(page.html).toContain(`Guard enrols this Mac in ${sessionOrg} for ${two.email}.`);
    expect(page.html).not.toContain(`in ${otherOrg} for`);
    const minted = await press(enrol(), { cookie: two.cookie, "user-agent": MAC });
    expect(minted.html).toContain(`It enrols a Mac in ${sessionOrg} for ${two.email}.`);
    const grew = sessionOrg === (await orgNameOf(owner)) ? [ownerBefore + 1, eliBefore] : [ownerBefore, eliBefore + 1];
    expect([await rowsIn(owner), await rowsIn(eli)]).toEqual(grew);
  });

  it("gives a try-again page, not sign-in or join advice, when the sign-in cannot be read, and makes no link", async () => {
    const members = registry.server.auth!.members;
    const membershipOf = members.membershipOf.bind(members);
    const before = (await enrolLinkRows()).length;
    members.membershipOf = async (userId, preferredOrgId) => {
      if (userId === member.userId) throw new Error("session store unavailable");
      return membershipOf(userId, preferredOrgId);
    };
    try {
      for (const answer of [await open(enrol(), { cookie: member.cookie, "user-agent": MAC }), await press(enrol(), { cookie: member.cookie, "user-agent": MAC })]) {
        expect(answer.status).toBe(503);
        expect(answer.html).toContain("Guard could not check your sign-in");
        expect(answer.html).toContain("Try again");
        expect(answer.html).not.toContain("/login?");
        expect(answer.html).not.toContain("/start?");
      }
      const consoleSession = await fetch(`${registry.url}/api/console/session`, { headers: { cookie: member.cookie } });
      expect(consoleSession.status).toBe(500);
    } finally {
      members.membershipOf = membershipOf;
    }
    expect(await enrolLinkRows()).toHaveLength(before);
    expect((await open(enrol(), { cookie: member.cookie, "user-agent": MAC })).status).toBe(200);
  });

  it("is told their address is not verified, and gets no link", async () => {
    const adapter = await registry.server.auth!.adapter();
    const before = (await enrolLinkRows()).length;
    await adapter.update({ model: "user", where: [{ field: "id", value: member.userId }], update: { emailVerified: false } });
    try {
      expect((await open(enrol(), { cookie: member.cookie })).html).toContain("Your email address is not verified");
      expect((await press(enrol(), { cookie: member.cookie })).status).toBe(403);
    } finally {
      await adapter.update({ model: "user", where: [{ field: "id", value: member.userId }], update: { emailVerified: true } });
    }
    expect(await enrolLinkRows()).toHaveLength(before);
  });

  it("sends a signed-in person who is in no organisation to the start page, which lists their invitations and comes back here", async () => {
    await invite(owner, "wes@dead-ends.example");
    const { cookie } = await signUp("wes@dead-ends.example");
    const before = (await enrolLinkRows()).length;
    const page = await open(enrol(), { cookie });
    expect(page.status).toBe(200);
    expect(page.html).toContain(`/start?next=${encodeURIComponent("/guard/enrol")}`);
    expect(page.html).not.toContain("<form");
    expect((await press(enrol(), { cookie })).status).toBe(403);
    expect(await enrolLinkRows()).toHaveLength(before);
  });

  it("limits each person on each address without locking anybody else out", async () => {
    const quick = registry.people.admin;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await open(enrol(), { cookie: quick.cookie })).status);
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await open(enrol(), { cookie: member.cookie })).status).toBe(200);
  });
});

describe("the page that hands out the enrol link", () => {
  it("gives the download and says to install Guard first", async () => {
    const minted = await press(`${registry.url}/guard/enrol`, { cookie: member.cookie, "user-agent": MAC });
    expect(minted.status).toBe(200);
    expect(minted.html).toContain(`href="${DOWNLOAD}"`);
    expect(minted.html).toContain("Install Guard first");
    expect(minted.html).toContain("This works only on a Mac.");
  });

  it("says to install Guard first even when this server has no download to give", async () => {
    const plain = await startRegistry({ domain: "no-download-dead-ends.example" });
    try {
      const minted = await press(`${plain.url}/guard/enrol`, { cookie: plain.people.member.cookie });
      expect(minted.status, minted.html).toBe(200);
      expect(minted.html).toContain("Install Guard first");
      expect(minted.html).not.toContain(DOWNLOAD);
    } finally {
      await plain.close();
    }
  });
});

describe("an enrol page opened on a device that is not a Mac", () => {
  let tokenLink: string;
  beforeAll(async () => {
    const reminded = await registry.consoleWrite(owner, "POST", `/people/${member.userId}/onboarding/remind`);
    expect(reminded.status, reminded.text).toBe(200);
    tokenLink = linkIn(box.sent.at(-1)!.text, "/guard/enrol").replace(REGISTRY_ORIGIN, registry.url);
  });

  it("says to open the email on the Mac being enrolled, and makes no link", async () => {
    const before = (await enrolLinkRows()).length;
    for (const agent of [IPHONE, ANDROID, WINDOWS]) {
      const page = await open(tokenLink, { cookie: member.cookie, "user-agent": agent });
      expect(page.status, agent).toBe(200);
      expect(page.html, agent).toContain("Open this email on the Mac you are enrolling");
      expect(page.html, agent).not.toContain("<form");
      const pressed = await press(tokenLink, { cookie: member.cookie, "user-agent": agent });
      expect(pressed.html, agent).toContain("Open this email on the Mac you are enrolling");
      expect(pressed.html, agent).not.toContain("vibtra-guard://");
    }
    const self = await open(`${registry.url}/guard/enrol`, { cookie: member.cookie, "user-agent": IPHONE });
    expect(self.html).toContain("Open this page on the Mac you are enrolling");
    expect(self.html).not.toContain("<form");
    expect(await enrolLinkRows()).toHaveLength(before);
  });

  it("still offers the button to a Mac, and to a browser that does not say what it runs on", async () => {
    const browsers: Array<Record<string, string>> = [{ "user-agent": MAC }, {}];
    for (const headers of browsers) {
      const page = await open(tokenLink, { cookie: member.cookie, ...headers });
      expect(page.html, JSON.stringify(headers)).toContain("Make my enrol link");
    }
  });
});
