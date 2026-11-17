import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostedConfig } from "@vibtra/registry";
import { loadRegistryConfig } from "@vibtra/registry/src/config.ts";
import type { MailAdapter, MailMessage } from "@vibtra/registry/src/mail/mailer.ts";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
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

  it("asks the invited person to accept first, then mints a one-time enrol link for them on POST only", async () => {
    const enrol = linkIn(box.sent[0]!.text, "/guard/enrol").replace("http://registry.test.local", registry.url);
    const before = await fetch(enrol);
    expect(await before.text()).toContain("Accept your invitation first");
    const early = await fetch(enrol, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(await early.text()).toContain("Accept your invitation first");

    const lee = await registry.join("lee", "mail-on.example");
    const id = /invitation=([^\s&]+)/.exec(box.sent[0]!.text)?.[1] ?? "";
    const accepted = await fetch(`${registry.url}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { cookie: lee.cookie, origin: "http://registry.test.local", "content-type": "application/json" },
      body: JSON.stringify({ invitationId: decodeURIComponent(id) }),
    });
    expect(accepted.status, await accepted.text()).toBe(200);

    const linksBefore = (await registry.consoleGet(registry.people.owner, "/guard/devices/enrol-links")).body as { rows: unknown[] };
    const page = await fetch(enrol);
    expect(await page.text()).toContain("Make my enrol link");
    const afterGet = (await registry.consoleGet(registry.people.owner, "/guard/devices/enrol-links")).body as { rows: unknown[] };
    expect(afterGet.rows).toHaveLength(linksBefore.rows.length);

    const minted = await fetch(enrol, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    const html = await minted.text();
    expect(minted.status, html).toBe(200);
    expect(html).toContain("vibtra-guard://enrol?server=");
    expect(html).toContain("vibtra-guard enrol --server");
    const afterPost = (await registry.consoleGet(registry.people.owner, "/guard/devices/enrol-links")).body as { rows: Array<{ personEmail: string; createdBy: string }> };
    expect(afterPost.rows).toHaveLength(linksBefore.rows.length + 1);
    expect(afterPost.rows[0]).toMatchObject({ personEmail: "lee@mail-on.example", createdBy: "lee@mail-on.example" });
  });

  it("answers 410 for a link past its fourteen days", async () => {
    const download = linkIn(box.sent[0]!.text, "/guard/download").replace("http://registry.test.local", registry.url);
    clock.advance(15 * 86_400_000);
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
});

describe("the invitation, with mail off", () => {
  let registry: TestRegistry;
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
