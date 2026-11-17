import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostedConfig } from "@vibtra/registry";
import { loadRegistryConfig } from "@vibtra/registry/src/config.ts";
import type { MailAdapter, MailMessage } from "@vibtra/registry/src/mail/mailer.ts";
import { REGISTRY_ORIGIN, startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { manualClock, withHosted } from "./server-options.ts";

const hosted: NodeJS.ProcessEnv = {
  REGISTRY_MODE: "hosted",
  REGISTRY_BASE_URL: "https://guard.example",
  REGISTRY_SESSION_SECRET: "guard-tests-session-secret-0123456789abcdef0123",
  REGISTRY_OIDC_CLIENT_ID: "guard-self-host",
  REGISTRY_OIDC_CLIENT_SECRET: "self-host-client-secret-not-real",
  NODE_ENV: "test",
};

const refusal = (env: NodeJS.ProcessEnv): string => {
  try {
    loadRegistryConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("loadRegistryConfig accepted the environment");
};

const outbox = (name: string): { adapter: MailAdapter; sent: MailMessage[]; from: Array<string | undefined> } => {
  const sent: MailMessage[] = [];
  const from: Array<string | undefined> = [];
  return {
    sent,
    from,
    adapter: {
      name,
      create: (ctx) => {
        from.push(ctx.from);
        return {
          send: async (message) => {
            sent.push(message);
            return true;
          },
        };
      },
    },
  };
};

const post = (url: string, cookie?: string, from: Record<string, string> = { origin: REGISTRY_ORIGIN }): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie === undefined ? {} : { cookie }), ...from },
    body: "",
  });

const linkIn = (text: string, path: string): string => {
  const match = new RegExp(`https?://[^\\s]+${path}/[A-Za-z0-9_.-]+`).exec(text);
  if (match === null) throw new Error(`no ${path} link in the email`);
  return match[0];
};

describe("mail adapter selection at boot", () => {
  it("keeps an existing RESEND_API_KEY + REGISTRY_MAIL_FROM setup on Resend, with no new variable", () => {
    const config = loadRegistryConfig({ ...hosted, RESEND_API_KEY: "re_test_FAKE", REGISTRY_MAIL_FROM: "Guard <no-reply@guard.example>" });
    expect(config.hosted).toMatchObject({ resendApiKey: "re_test_FAKE", mailFrom: "Guard <no-reply@guard.example>" });
    expect(config.hosted?.mailAdapter).toBeUndefined();
  });

  it("still refuses half of the Resend pair", () => {
    expect(refusal({ ...hosted, RESEND_API_KEY: "re_test_FAKE" })).toBe("Mail is half configured");
    expect(refusal({ ...hosted, REGISTRY_MAIL_FROM: "Guard <no-reply@guard.example>" })).toBe("REGISTRY_MAIL_FROM is set but RESEND_API_KEY is not");
  });

  it("accepts VIBTRA_MAIL_ADAPTER as a known variable and reads none, resend and a custom name", () => {
    expect(loadRegistryConfig({ ...hosted, VIBTRA_MAIL_ADAPTER: "none" }).hosted?.mailAdapter).toBe("none");
    expect(loadRegistryConfig({ ...hosted, VIBTRA_MAIL_ADAPTER: "smtp", REGISTRY_MAIL_FROM: "it@guard.example" }).hosted).toMatchObject({ mailAdapter: "smtp", mailFrom: "it@guard.example" });
    expect(loadRegistryConfig({ ...hosted, VIBTRA_MAIL_ADAPTER: "resend", RESEND_API_KEY: "re_test_FAKE", REGISTRY_MAIL_FROM: "a@guard.example" }).hosted?.mailAdapter).toBe("resend");
  });

  it("refuses settings the chosen adapter would ignore", () => {
    expect(refusal({ ...hosted, VIBTRA_MAIL_ADAPTER: "none", RESEND_API_KEY: "re_test_FAKE" })).toBe("RESEND_API_KEY is set but VIBTRA_MAIL_ADAPTER=none");
    expect(refusal({ ...hosted, VIBTRA_MAIL_ADAPTER: "none", REGISTRY_MAIL_FROM: "a@guard.example" })).toBe("REGISTRY_MAIL_FROM is set but VIBTRA_MAIL_ADAPTER=none");
    expect(refusal({ ...hosted, VIBTRA_MAIL_ADAPTER: "smtp", RESEND_API_KEY: "re_test_FAKE" })).toBe("RESEND_API_KEY is set but VIBTRA_MAIL_ADAPTER=smtp");
    expect(refusal({ ...hosted, VIBTRA_MAIL_ADAPTER: "resend" })).toBe("VIBTRA_MAIL_ADAPTER=resend, but RESEND_API_KEY is not set");
  });

  it("refuses an adapter name that is not a name, and the new variables outside hosted mode", () => {
    expect(refusal({ ...hosted, VIBTRA_MAIL_ADAPTER: "Not A Name" })).toBe("Invalid registry configuration");
    expect(refusal({ REGISTRY_MODE: "single", VIBTRA_MAIL_ADAPTER: "resend" })).toBe("VIBTRA_MAIL_ADAPTER is set but REGISTRY_MODE is not hosted");
    expect(refusal({ REGISTRY_MODE: "single", VIBTRA_GUARD_DOWNLOAD_URL: "https://dl.example/guard.pkg" })).toBe("VIBTRA_GUARD_DOWNLOAD_URL is set but REGISTRY_MODE is not hosted");
  });

  it("takes an https download URL, and refuses plain http on an https registry", () => {
    expect(loadRegistryConfig({ ...hosted, VIBTRA_GUARD_DOWNLOAD_URL: "https://dl.example/guard.pkg" }).hosted?.guardDownloadUrl).toBe("https://dl.example/guard.pkg");
    expect(refusal({ ...hosted, VIBTRA_GUARD_DOWNLOAD_URL: "http://dl.example/guard.pkg" })).toBe("VIBTRA_GUARD_DOWNLOAD_URL must use https");
  });
});

describe("mail adapter registration", () => {
  const boot = async (patch: Partial<HostedConfig>, adapters: { cli?: MailAdapter[]; ee?: MailAdapter[] }): Promise<string | undefined> => {
    try {
      const registry = await startRegistry({
        configure: (options) => ({
          ...withHosted((h) => ({ ...h, ...patch }))(options),
          ...(adapters.cli === undefined ? {} : { mailAdapters: adapters.cli }),
          ...(adapters.ee === undefined
            ? {}
            : { enterprise: { status: { licensed: false, features: [] }, available: () => ({ ok: false, reason: "test" }), mailAdapters: adapters.ee } }),
        }),
      });
      await registry.close();
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("refuses to boot when VIBTRA_MAIL_ADAPTER names an adapter nobody registered", async () => {
    expect(await boot({ mailAdapter: "smtp" }, {})).toBe("VIBTRA_MAIL_ADAPTER names a mail adapter this registry does not have: smtp");
  });

  it("refuses an adapter that reuses a built-in name or is registered twice", async () => {
    expect(await boot({}, { cli: [outbox("resend").adapter] })).toBe("A registered mail adapter reuses a built-in name");
    expect(await boot({}, { cli: [outbox("smtp").adapter], ee: [outbox("smtp").adapter] })).toBe("Two mail adapters were registered under one name");
  });

  it("builds an adapter registered by the enterprise layer, handing it REGISTRY_MAIL_FROM", async () => {
    const box = outbox("ses");
    expect(await boot({ mailAdapter: "ses", mailFrom: "IT <it@guard.example>" }, { ee: [box.adapter] })).toBeUndefined();
    expect(box.from).toEqual(["IT <it@guard.example>"]);
  });

  it("boots an adapter that declares its own VIBTRA_ setting, hands it the value, and sends through it", async () => {
    const sent: MailMessage[] = [];
    const tokens: Array<string | undefined> = [];
    const postbox: MailAdapter = {
      name: "postbox",
      env: ["VIBTRA_POSTBOX_TOKEN"],
      create: (ctx) => {
        tokens.push(ctx.env.VIBTRA_POSTBOX_TOKEN);
        return { send: async (message) => (sent.push(message), true) };
      },
    };
    const env = { ...hosted, VIBTRA_MAIL_ADAPTER: "postbox", VIBTRA_POSTBOX_TOKEN: "pb_test_FAKE", REGISTRY_MAIL_FROM: "IT <it@postbox.example>" };
    expect(refusal(env)).toBe("Unknown VIBTRA_* variable: VIBTRA_POSTBOX_TOKEN");
    const mailEnv = loadRegistryConfig(env, undefined, undefined, [postbox]).hosted?.mailEnv;
    expect(mailEnv).toEqual({ VIBTRA_POSTBOX_TOKEN: "pb_test_FAKE" });
    const registry = await startRegistry({
      domain: "postbox.example",
      configure: (options) => ({ ...withHosted((h) => ({ ...h, mailAdapter: "postbox", mailFrom: "IT <it@postbox.example>", mailEnv }))(options), mailAdapters: [postbox] }),
    });
    try {
      const invited = await registry.consoleWrite(registry.people.owner, "POST", "/people/invitations", { email: "pat@postbox.example", role: "member" });
      expect(invited.body).toMatchObject({ delivery: "emailed" });
      expect(tokens).toEqual(["pb_test_FAKE"]);
      expect(sent.map((message) => message.to)).toEqual(["pat@postbox.example"]);
    } finally {
      await registry.close();
    }
  });

  it("leaves a registered adapter unbuilt unless it is selected", async () => {
    const box = outbox("smtp");
    expect(await boot({}, { cli: [box.adapter] })).toBeUndefined();
    expect(box.from).toEqual([]);
  });
});

describe("the invitation, with mail on through a registered adapter", () => {
  const box = outbox("smtp");
  const clock = manualClock(new Date("2026-11-17T09:00:00.000Z"));
  let registry: TestRegistry;
  let lee: Person;
  const enrolLinkCount = async (): Promise<number> => ((await registry.consoleGet(registry.people.owner, "/guard/devices/enrol-links")).body as { rows: unknown[] }).rows.length;

  beforeAll(async () => {
    registry = await startRegistry({
      domain: "mail-on.example",
      configure: (options) => ({
        ...withHosted((h) => ({ ...h, mailAdapter: "smtp", mailFrom: "IT <it@mail-on.example>", guardDownloadUrl: "https://downloads.example/guard-1.0.pkg" }))(options),
        mailAdapters: [box.adapter],
        clock,
      }),
    });
  });
  afterAll(async () => registry?.close());

  it("says mail is on, emails the invitation and hands out no link to copy", async () => {
    expect((await registry.consoleGet(registry.people.owner, "/people")).body).toMatchObject({ mailEnabled: true });
    const invited = await registry.consoleWrite(registry.people.owner, "POST", "/people/invitations", { email: "Lee@Mail-On.example", role: "member" });
    expect(invited.status, invited.text).toBe(200);
    const id = String((invited.body as { invitationId: string }).invitationId);
    expect(invited.body).toMatchObject({ delivery: "emailed", emailed: true });
    expect(invited.body).not.toHaveProperty("inviteUrl");
    expect(box.sent).toHaveLength(1);
    const mail = box.sent[0]!;
    expect(mail.to).toBe("lee@mail-on.example");
    expect(mail.text).toContain(`/login?invitation=${encodeURIComponent(id)}`);
    expect(mail.text).toContain("Notice of computer surveillance");
    expect(mail.text).toContain("from the day Guard is enrolled on your Mac");
    expect(mail.text).not.toContain("{{");
    expect(mail.text).toContain("http://registry.test.local/guard/download/");
    expect(mail.text).toContain("http://registry.test.local/guard/enrol/");
  });

  it("sends nothing when a member tries to invite", async () => {
    const before = box.sent.length;
    const refused = await registry.consoleWrite(registry.people.member, "POST", "/people/invitations", { email: "nope@mail-on.example", role: "member" });
    expect(refused.status).toBe(403);
    expect(box.sent).toHaveLength(before);
  });

  it("redirects the signed download link to the configured download, and refuses a changed or expired one", async () => {
    const download = linkIn(box.sent[0]!.text, "/guard/download").replace("http://registry.test.local", registry.url);
    const followed = await fetch(download, { redirect: "manual" });
    expect([followed.status, followed.headers.get("location")]).toEqual([303, "https://downloads.example/guard-1.0.pkg"]);

    const changed = await fetch(`${download.slice(0, -2)}${download.endsWith("AA") ? "BB" : "AA"}`, { redirect: "manual" });
    expect(changed.status).toBe(404);
    expect(await changed.text()).toContain("This link does not work");

    const enrolAsDownload = linkIn(box.sent[0]!.text, "/guard/enrol").replace("http://registry.test.local/guard/enrol", `${registry.url}/guard/download`);
    expect((await fetch(enrolAsDownload, { redirect: "manual" })).status).toBe(404);
  });

  it("sends the invited person to accept first, then to sign in as themselves, and mints only for that session", async () => {
    const link = linkIn(box.sent[0]!.text, "/guard/enrol");
    const enrol = link.replace(REGISTRY_ORIGIN, registry.url);
    const back = encodeURIComponent(new URL(link).pathname);
    const pending = await fetch(enrol);
    const pendingHtml = await pending.text();
    expect(pendingHtml).toContain("Accept your invitation first");
    expect(pendingHtml).toContain(`next=${back}`);
    expect((await post(enrol)).status).toBe(403);

    const id = /invitation=([^\s&]+)/.exec(box.sent[0]!.text)?.[1] ?? "";
    lee = await registry.join("lee", "mail-on.example", decodeURIComponent(id));

    const linksBefore = await enrolLinkCount();
    const anonymous = await (await fetch(enrol)).text();
    expect(anonymous).toContain("Sign in as lee@mail-on.example");
    expect(anonymous).toContain(`/login?next=${back}`);
    expect((await post(enrol)).status).toBe(401);
    const wrong = await post(enrol, registry.people.member.cookie);
    expect([wrong.status, await wrong.text()]).toEqual([403, expect.stringContaining("signed in with another account")]);
    const elsewhere: Array<Record<string, string>> = [{ origin: "https://elsewhere.example" }, {}, { "sec-fetch-site": "cross-site" }, { referer: "https://elsewhere.example/guard/enrol/x" }];
    for (const from of elsewhere) {
      const refused = await post(enrol, lee.cookie, from);
      expect([refused.status, await refused.text()], JSON.stringify(from)).toEqual([403, expect.stringContaining("This form did not come from Guard")]);
    }
    expect(await enrolLinkCount()).toBe(linksBefore);

    const adapter = await registry.server.auth!.adapter();
    await adapter.update({ model: "user", where: [{ field: "id", value: lee.userId }], update: { emailVerified: false } });
    expect(await (await fetch(enrol, { headers: { cookie: lee.cookie } })).text()).toContain("Your email address is not verified");
    const unverified = await post(enrol, lee.cookie);
    expect([unverified.status, await unverified.text()]).toEqual([403, expect.stringContaining("not verified")]);
    expect(await enrolLinkCount()).toBe(linksBefore);
    const orgId = String(((await registry.consoleGet(registry.people.owner, "/session")).body as { orgId: string }).orgId);
    await adapter.create({ model: "account", data: { issuer: "https://idp.mail-on.example", accountId: "lee-at-idp", providerId: "sso-mail-on", userId: lee.userId, createdAt: new Date(), updatedAt: new Date() } });
    expect(await (await fetch(enrol, { headers: { cookie: lee.cookie } })).text()).toContain("Your email address is not verified");
    const stranger = await registry.join("ola", "sso-elsewhere.example");
    const strangerOrgId = String(((await registry.consoleGet(stranger, "/session")).body as { orgId: string }).orgId);
    expect(strangerOrgId).not.toBe(orgId);
    await adapter.create({
      model: "ssoProvider",
      data: { providerId: "sso-elsewhere", issuer: "https://idp.sso-elsewhere.example", domain: "sso-elsewhere.example", organizationId: strangerOrgId, userId: stranger.userId, oidcConfig: "{}" },
    });
    await adapter.create({ model: "account", data: { issuer: "https://idp.sso-elsewhere.example", accountId: "lee-at-elsewhere", providerId: "sso-elsewhere", userId: lee.userId, createdAt: new Date(), updatedAt: new Date() } });
    expect(await (await fetch(enrol, { headers: { cookie: lee.cookie } })).text()).toContain("Your email address is not verified");
    const vouchedElsewhere = await post(enrol, lee.cookie);
    expect([vouchedElsewhere.status, await vouchedElsewhere.text()]).toEqual([403, expect.stringContaining("not verified")]);
    expect(await enrolLinkCount()).toBe(linksBefore);
    await adapter.create({
      model: "ssoProvider",
      data: { providerId: "sso-mail-on", issuer: "https://idp.mail-on.example", domain: "mail-on.example", organizationId: orgId, userId: registry.people.owner.userId, oidcConfig: "{}" },
    });
    expect(await (await fetch(enrol, { headers: { cookie: lee.cookie } })).text()).toContain("Make my enrol link");
    await adapter.update({ model: "user", where: [{ field: "id", value: lee.userId }], update: { emailVerified: true } });

    const page = await fetch(enrol, { headers: { cookie: lee.cookie } });
    expect(await page.text()).toContain("Make my enrol link");
    expect(await enrolLinkCount()).toBe(linksBefore);

    expect((await post(enrol, lee.cookie, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post(enrol, lee.cookie, { referer: `${REGISTRY_ORIGIN}/guard/enrol/x` })).status).toBe(200);
    expect(await enrolLinkCount()).toBe(linksBefore + 2);
    const minted = await post(enrol, lee.cookie);
    const html = await minted.text();
    expect(minted.status, html).toBe(200);
    expect(html).toContain("vibtra-guard://enrol?server=");
    expect(html).toContain("vibtra-guard enrol --server");
    const afterPost = (await registry.consoleGet(registry.people.owner, "/guard/devices/enrol-links")).body as { rows: Array<{ personEmail: string; createdBy: string }> };
    expect(afterPost.rows).toHaveLength(linksBefore + 3);
    expect(afterPost.rows[0]).toMatchObject({ personEmail: "lee@mail-on.example", createdBy: "lee@mail-on.example" });
  });

  it("re-sends with fresh links in a fresh email, and the old links stop working", async () => {
    const invited = await registry.consoleWrite(registry.people.owner, "POST", "/people/invitations", { email: "sam@mail-on.example", role: "member" });
    const invitationId = String((invited.body as { invitationId: string }).invitationId);
    const first = box.sent.at(-1)!;
    const oldDownload = linkIn(first.text, "/guard/download").replace(REGISTRY_ORIGIN, registry.url);
    const oldEnrol = linkIn(first.text, "/guard/enrol").replace(REGISTRY_ORIGIN, registry.url);
    expect((await fetch(oldDownload, { redirect: "manual" })).status).toBe(303);

    clock.advance(60_000);
    const resent = await registry.consoleWrite(registry.people.owner, "POST", `/people/invitations/${invitationId}/resend`);
    expect(resent.status, resent.text).toBe(200);
    expect(resent.body).toMatchObject({ invitationId, delivery: "emailed", emailed: true });
    expect(resent.body).not.toHaveProperty("inviteUrl");
    const second = box.sent.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.to).toBe("sam@mail-on.example");
    const newDownload = linkIn(second.text, "/guard/download").replace(REGISTRY_ORIGIN, registry.url);
    expect(newDownload).not.toBe(oldDownload);

    expect((await fetch(oldDownload, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(oldEnrol)).status).toBe(404);
    expect((await fetch(newDownload, { redirect: "manual" })).status).toBe(303);
    const row = ((await registry.consoleGet(registry.people.owner, "/people/onboarding")).body as { rows: Array<{ email: string; lastSentAt?: string }> }).rows.find((r) => r.email === "sam@mail-on.example");
    expect(row?.lastSentAt).toBe(clock.now().toISOString());
  });

  it("reminds a member with fresh links that replace the last ones and the invitation's, records the send and restarts the chase", async () => {
    const remind = () => registry.consoleWrite(registry.people.owner, "POST", `/people/${lee.userId}/onboarding/remind`);
    clock.advance(60_000);
    const first = await remind();
    expect(first.status, first.text).toBe(200);
    expect(first.body).toEqual({ userId: lee.userId, email: "lee@mail-on.example", delivery: "emailed", lastSentAt: clock.now().toISOString() });
    const mail = box.sent.at(-1)!;
    expect(mail.to).toBe("lee@mail-on.example");
    expect(mail.subject).toContain("Reminder");
    expect(mail.text).toContain("Notice of computer surveillance");
    const firstEnrol = linkIn(mail.text, "/guard/enrol").replace(REGISTRY_ORIGIN, registry.url);
    expect(await (await fetch(firstEnrol, { headers: { cookie: lee.cookie } })).text()).toContain("Make my enrol link");
    expect((await fetch(linkIn(mail.text, "/guard/download").replace(REGISTRY_ORIGIN, registry.url), { redirect: "manual" })).status).toBe(303);
    const invitationEnrol = linkIn(box.sent[0]!.text, "/guard/enrol").replace(REGISTRY_ORIGIN, registry.url);
    expect((await fetch(invitationEnrol, { headers: { cookie: lee.cookie } })).status).toBe(404);
    expect((await fetch(linkIn(box.sent[0]!.text, "/guard/download").replace(REGISTRY_ORIGIN, registry.url), { redirect: "manual" })).status).toBe(404);
    const rows = ((await registry.consoleGet(registry.people.owner, "/people/onboarding")).body as { rows: Array<{ kind: string; email: string; lastSentAt?: string; chase: boolean }> }).rows;
    expect(rows.find((r) => r.email === "lee@mail-on.example")).toMatchObject({ kind: "person", lastSentAt: clock.now().toISOString(), chase: false });

    clock.advance(60_000);
    const second = await remind();
    expect(second.body).toMatchObject({ delivery: "emailed", lastSentAt: clock.now().toISOString() });
    expect((await fetch(firstEnrol, { headers: { cookie: lee.cookie } })).status).toBe(404);
    const secondEnrol = linkIn(box.sent.at(-1)!.text, "/guard/enrol").replace(REGISTRY_ORIGIN, registry.url);
    expect(await (await fetch(secondEnrol, { headers: { cookie: lee.cookie } })).text()).toContain("Make my enrol link");
  });

  it("sends one person at most five onboarding emails an hour", async () => {
    const remind = () => registry.consoleWrite(registry.people.owner, "POST", `/people/${lee.userId}/onboarding/remind`);
    for (let sent = 2; sent < 5; sent += 1) expect((await remind()).status).toBe(200);
    const before = box.sent.length;
    const refused = await remind();
    expect([refused.status, (refused.body as { code?: string }).code]).toEqual([429, "REGISTRY_LIMIT_EXCEEDED"]);
    expect(box.sent).toHaveLength(before);
    const retryAfter = Number(/Try again in (\d+) seconds/.exec(String((refused.body as { detail?: string }).detail))?.[1]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  it("stops a link working when its invitation expires, before its fourteen days are up", async () => {
    const latestToSam = [...box.sent].reverse().find((message) => message.to === "sam@mail-on.example")!;
    const download = linkIn(latestToSam.text, "/guard/download").replace(REGISTRY_ORIGIN, registry.url);
    expect((await fetch(download, { redirect: "manual" })).status).toBe(303);
    const expiresAt = Date.parse(/stops working on (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(latestToSam.text)?.[1] ?? "");
    expect(expiresAt - clock.now().getTime()).toBeLessThan(14 * 86_400_000);
    clock.set(new Date(expiresAt + 1_000).toISOString());
    const expired = await fetch(download, { redirect: "manual" });
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("This link has expired");
  });
});

describe("the invitation, when the mail adapter throws", () => {
  let registry: TestRegistry;
  const broken: MailAdapter = {
    name: "broken",
    create: () => ({
      send: async () => {
        throw new TypeError("socket hang up");
      },
    }),
  };
  beforeAll(async () => {
    registry = await startRegistry({
      domain: "mail-broken.example",
      configure: (options) => ({ ...withHosted((h) => ({ ...h, mailAdapter: "broken" }))(options), mailAdapters: [broken] }),
    });
  });
  afterAll(async () => registry?.close());

  it("answers send_failed with the link to copy instead of a 500, and records no send", async () => {
    const invited = await registry.consoleWrite(registry.people.owner, "POST", "/people/invitations", { email: "rio@mail-broken.example", role: "member" });
    expect(invited.status, invited.text).toBe(200);
    const id = String((invited.body as { invitationId: string }).invitationId);
    expect(invited.body).toMatchObject({ delivery: "send_failed", emailed: false, inviteUrl: `http://registry.test.local/login?invitation=${encodeURIComponent(id)}` });
    const page = (await registry.consoleGet(registry.people.owner, "/people/onboarding")).body as { rows: Array<{ email: string; lastSentAt?: string }> };
    const row = page.rows.find((r) => r.email === "rio@mail-broken.example");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("lastSentAt");
  });

  it("answers a reminder it could not send with an enrol link that works, and records no send", async () => {
    const { owner, member } = registry.people;
    const reminded = await registry.consoleWrite(owner, "POST", `/people/${member.userId}/onboarding/remind`);
    expect(reminded.status, reminded.text).toBe(200);
    expect(reminded.body).toMatchObject({ userId: member.userId, delivery: "send_failed" });
    expect(reminded.body).not.toHaveProperty("lastSentAt");
    const enrolUrl = String((reminded.body as { enrolUrl: string }).enrolUrl).replace(REGISTRY_ORIGIN, registry.url);
    expect(await (await fetch(enrolUrl, { headers: { cookie: member.cookie } })).text()).toContain("Make my enrol link");
    const rows = ((await registry.consoleGet(owner, "/people/onboarding")).body as { rows: Array<{ email: string; lastSentAt?: string }> }).rows;
    expect(rows.find((r) => r.email === member.email)).not.toHaveProperty("lastSentAt");
  });
});

describe("the invitation, with mail off", () => {
  let registry: TestRegistry;
  let remindedLink: string;
  beforeAll(async () => {
    registry = await startRegistry({ domain: "mail-off.example" });
  });
  afterAll(async () => registry?.close());

  it("says mail is off, emails nothing and returns the invite link to copy", async () => {
    expect((await registry.consoleGet(registry.people.owner, "/people")).body).toMatchObject({ mailEnabled: false });
    const invited = await registry.consoleWrite(registry.people.owner, "POST", "/people/invitations", { email: "kim@mail-off.example", role: "admin" });
    expect(invited.status, invited.text).toBe(200);
    const id = String((invited.body as { invitationId: string }).invitationId);
    expect(invited.body).toMatchObject({ delivery: "mail_off", emailed: false, inviteUrl: `http://registry.test.local/login?invitation=${encodeURIComponent(id)}` });
  });

  it("answers a reminder with the enrol link to pass on, records the send, and the link works for that person only", async () => {
    const { owner, member, admin } = registry.people;
    const reminded = await registry.consoleWrite(owner, "POST", `/people/${member.userId}/onboarding/remind`);
    expect(reminded.status, reminded.text).toBe(200);
    expect(reminded.body).toMatchObject({ userId: member.userId, email: member.email, delivery: "mail_off", lastSentAt: expect.any(String) });
    const enrolUrl = String((reminded.body as { enrolUrl: string }).enrolUrl);
    expect(enrolUrl.startsWith(`${REGISTRY_ORIGIN}/guard/enrol/`)).toBe(true);
    remindedLink = enrolUrl.replace(REGISTRY_ORIGIN, registry.url);
    expect(await (await fetch(remindedLink, { headers: { cookie: member.cookie } })).text()).toContain("Make my enrol link");
    expect((await post(remindedLink, admin.cookie)).status).toBe(403);
  });

  it("limits how often one address may open one link, without locking anybody out of their own", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await fetch(`${registry.url}/guard/download/not.a.link`)).status);
    const firstRefusal = statuses.indexOf(429);
    expect(firstRefusal).toBeGreaterThan(0);
    expect(statuses.slice(0, firstRefusal).every((status) => status === 404)).toBe(true);
    expect(statuses.slice(firstRefusal).every((status) => status === 429)).toBe(true);
    const refused = await fetch(`${registry.url}/guard/download/not.a.link`);
    expect([refused.status, Number(refused.headers.get("retry-after")) > 0]).toEqual([429, true]);
    expect(await refused.text()).toContain("Too many tries");
    expect(await (await fetch(remindedLink, { headers: { cookie: registry.people.member.cookie } })).text()).toContain("Make my enrol link");
  });

  it("explains that IT sends Guard when no download URL is configured", async () => {
    const box = outbox("smtp");
    const mailing = await startRegistry({
      domain: "no-download.example",
      configure: (options) => ({ ...withHosted((h) => ({ ...h, mailAdapter: "smtp" }))(options), mailAdapters: [box.adapter] }),
    });
    try {
      await mailing.consoleWrite(mailing.people.owner, "POST", "/people/invitations", { email: "ash@no-download.example", role: "member" });
      const download = linkIn(box.sent[0]!.text, "/guard/download").replace("http://registry.test.local", mailing.url);
      const page = await fetch(download, { redirect: "manual" });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Your IT team sends Guard");
    } finally {
      await mailing.close();
    }
  });
});
