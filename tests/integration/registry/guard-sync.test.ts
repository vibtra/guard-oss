import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsoleGroupDetail } from "@vibtra/console-api";
import {
  GUARD_PROTOCOL_VERSION,
  GUARD_STARTER_CONTENT_RULES,
  GuardActivityPage,
  GuardAskResponse,
  GuardAsksResponse,
  GuardDevicesPage,
  GuardEnrolLinksPage,
  GuardEnrolResponse,
  GuardEventUploadResponse,
  GuardPreflightResponse,
  GuardRuleDownloadResponse,
  type GuardEventRow,
  type SignedGuardBundle,
} from "@vibtra/guard-contract";
import { digestOf, verifyGuardBundle, verifyGuardCatalogue } from "@vibtra/guard-contract/signing";
import { startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { CA, agentDoor, enrolDevice, eventId, facts, grantOf, mintEnrolLink, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";
import { capturingStorage, postgresMissing, sqlRows, type Storage } from "./server-options.ts";

const MADE_UP_TFN_DIGITS = /123[\s-]?456[\s-]?782|456[\s-]?782/;

let registry: TestRegistry;
let owner: Person;
let admin: Person;
let member: Person;
let dee: Person;

const download = async (laptop: EnrolledDevice, body: Record<string, unknown> = {}) => {
  const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, ...body });
  expect(reply.status, reply.text).toBe(200);
  return GuardRuleDownloadResponse.parse(reply.body);
};

const bundleOf = async (laptop: EnrolledDevice): Promise<SignedGuardBundle> => required((await download(laptop)).bundle, "a bundle on a first download");

const activityOf = async (laptop: EnrolledDevice): Promise<{ rows: GuardEventRow[]; text: string }> => {
  const reply = await registry.consoleGet(owner, `/guard/activity?deviceId=${laptop.deviceId}`);
  expect(reply.status, reply.text).toBe(200);
  return { rows: GuardActivityPage.parse(reply.body).rows, text: reply.text };
};

const settings = async (patch: Record<string, unknown>): Promise<void> => {
  const reply = await registry.consoleWrite(owner, "PUT", "/guard/settings", patch);
  expect(reply.status, reply.text).toBe(200);
};

beforeAll(async () => {
  registry = await startRegistry({ domain: "guard-sync.example" });
  ({ owner, admin, member } = registry.people);
  dee = await registry.join("dee");
  const made = await registry.consoleWrite(owner, "POST", "/groups", { name: "Finance" });
  if (made.status !== 201) throw new Error(`creating the Finance group answered ${made.status}: ${made.text.slice(0, 300)}`);
  const financeId = ConsoleGroupDetail.parse(made.body).row.id;
  const added = await registry.consoleWrite(owner, "POST", `/groups/${financeId}/members`, { email: member.email });
  if (added.status >= 300) throw new Error(`adding ${member.email} to Finance answered ${added.status}: ${added.text.slice(0, 300)}`);
  const rules = await registry.consoleWrite(owner, "PUT", "/guard/rules", {
    baseVersion: 0,
    document: {
      defaultAction: "allow",
      serviceRules: [
        { serviceId: "deepseek", audience: { kind: "org" }, action: "block", enabled: true },
        { serviceId: "openai-chatgpt", audience: { kind: "groups", groupIds: [financeId] }, action: "ask", enabled: true },
      ],
      contentRules: GUARD_STARTER_CONTENT_RULES.map((rule) => ({ ...rule, services: "*", audience: { kind: "org" }, enabled: true })),
    },
  });
  if (rules.status !== 200) throw new Error(`saving the rules answered ${rules.status}: ${rules.text.slice(0, 300)}`);
});

afterAll(async () => {
  await registry?.close();
});

describe("the sync cycle", () => {
  it("enrols, ships a per-person bundle the pinned key verifies, and says nothing changed after postflight", async () => {
    const laptop = await enrolDevice(registry, owner, member, "member-mbp");
    expect(laptop.enrol.person.email).toBe(member.email);
    expect(laptop.enrol.signing.alg).toBe("ES256");
    expect(laptop.link.command).toContain("vibtra-guard enrol --server http://registry.test.local --token genr_");

    const pre = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-mbp"));
    expect(pre.status, pre.text).toBe(200);
    expect(GuardPreflightResponse.parse(pre.body)).toMatchObject({
      cleanSync: true,
      rulesChanged: true,
      catalogueChanged: true,
      bundleVersion: 1,
      signingKeyId: laptop.enrol.signing.keyId,
      person: { email: member.email },
    });

    const first = await download(laptop);
    const bundle = required(first.bundle, "a bundle on a first download");
    const catalogue = required(first.catalogue, "a catalogue on a first download");
    const { publicKeyPem, keyId } = laptop.enrol.signing;
    expect(verifyGuardBundle(bundle, publicKeyPem, keyId, laptop.deviceId)).toMatchObject({ ok: true });
    expect(verifyGuardCatalogue(catalogue, publicKeyPem, keyId)).toMatchObject({ ok: true });
    expect(verifyGuardBundle(bundle, publicKeyPem, keyId, "gdev_ffffffffffffffff")).toMatchObject({ ok: false, reason: "wrong-device" });
    expect(bundle.bundle.person.email).toBe(member.email);
    expect(bundle.bundle.services.deepseek?.action).toBe("block");
    expect(bundle.bundle.services["openai-chatgpt"]?.action).toBe("ask");
    expect(bundle.bundle.contentRules.map((rule) => rule.name)).toContain("Tax file numbers");

    const ownerLaptop = await enrolDevice(registry, admin, owner, "owner-mbp");
    const ownerBundle = await bundleOf(ownerLaptop);
    expect(ownerBundle.bundle.services["openai-chatgpt"]).toBeUndefined();
    expect(ownerBundle.bundle.services.deepseek?.action).toBe("block");

    const digest = digestOf(bundle.bundle);
    const post = await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      bundleVersion: bundle.bundle.bundleVersion,
      catalogueVersion: catalogue.catalogue.version,
      rulesReceived: bundle.bundle.contentRules.length,
      rulesProcessed: bundle.bundle.contentRules.length,
      clientMode: "enforce",
      bundleDigest: digest,
    });
    expect(post.status, post.text).toBe(200);
    expect(post.body).toEqual({ ok: true, nextSyncInSeconds: 60 });

    const again = await agentDoor(
      registry,
      "POST",
      `/preflight/${laptop.deviceId}`,
      laptop.token,
      preflightBody("member-mbp", { bundleVersion: 1, catalogueVersion: catalogue.catalogue.version }),
    );
    expect(GuardPreflightResponse.parse(again.body)).toMatchObject({ cleanSync: false, rulesChanged: false, catalogueChanged: false });
    expect(await download(laptop, { bundleVersion: 1, catalogueVersion: catalogue.catalogue.version })).toEqual({});

    const devices = await registry.consoleGet(owner, "/guard/devices");
    expect(devices.status, devices.text).toBe(200);
    expect(GuardDevicesPage.parse(devices.body).rows.find((row) => row.deviceId === laptop.deviceId)).toMatchObject({
      hostname: "member-mbp",
      status: "active",
      clientMode: "monitor",
      bundleVersion: 1,
      bundleDigest: digest,
      quiet: false,
      person: { email: member.email },
    });
    expect(devices.text).not.toContain(laptop.token);
  });

  it("an approved guard grant changes the digest and reaches every laptop of that person only; a revoked one disappears", async () => {
    const laptop = await enrolDevice(registry, owner, member, "member-air");
    const before = await bundleOf(laptop);
    expect(before.bundle.exceptions).toEqual([]);
    const tfn = required(
      before.bundle.contentRules.find((rule) => rule.name === "Tax file numbers"),
      "the starter TFN rule",
    );
    const applied = await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      bundleVersion: before.bundle.bundleVersion,
      catalogueVersion: before.bundle.catalogueVersion,
      rulesReceived: 7,
      rulesProcessed: 7,
      clientMode: "enforce",
      bundleDigest: digestOf(before.bundle),
    });
    expect(applied.status, applied.text).toBe(200);

    const blockedEvent = eventId();
    const asked = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, {
      serviceId: "openai-chatgpt",
      ruleId: tfn.ruleId,
      matchType: "au-tfn",
      eventId: blockedEvent,
      app: "Google Chrome",
      note: "Made-up reason: the fictional tax return review",
    });
    expect(asked.status, asked.text).toBe(201);
    const ask = GuardAskResponse.parse(asked.body);
    expect(ask).toMatchObject({
      created: true,
      request: {
        kind: "guard",
        status: "pending",
        subject: {
          serviceId: "openai-chatgpt",
          serviceName: "ChatGPT",
          ruleId: tfn.ruleId,
          ruleName: "Tax file numbers",
          deviceId: laptop.deviceId,
          hostname: "member-air",
          eventId: blockedEvent,
        },
      },
    });
    const twice = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "openai-chatgpt", ruleId: tfn.ruleId });
    expect(twice.status, twice.text).toBe(200);
    expect(GuardAskResponse.parse(twice.body)).toMatchObject({ created: false, request: { requestId: ask.request.requestId } });

    const desk = await registry.consoleGet(admin, "/policy-requests?kind=guard");
    expect(desk.status, desk.text).toBe(200);
    expect(desk.body).toMatchObject({
      requests: expect.arrayContaining([
        expect.objectContaining({ id: ask.request.requestId, kind: "guard", status: "pending", words: 'sending what the rule "Tax file numbers" blocks to ChatGPT' }),
      ]),
    });
    expect(desk.text).not.toContain("fictional tax return review");

    const versions = { bundleVersion: before.bundle.bundleVersion, catalogueVersion: before.bundle.catalogueVersion };
    const unchanged = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-air", versions));
    expect(GuardPreflightResponse.parse(unchanged.body).rulesChanged).toBe(false);

    const approved = await registry.consoleWrite(admin, "POST", `/policy-requests/${ask.request.requestId}/approve`, { grant: { days: 7 } });
    expect(approved.status, approved.text).toBe(200);
    const grantId = grantOf(approved.body).id;

    const changed = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-air", versions));
    expect(GuardPreflightResponse.parse(changed.body)).toMatchObject({ rulesChanged: true, bundleVersion: before.bundle.bundleVersion });
    const after = required((await download(laptop, { bundleVersion: before.bundle.bundleVersion })).bundle, "a bundle after the grant");
    expect(after.bundle.bundleVersion).toBe(before.bundle.bundleVersion);
    expect(digestOf(after.bundle)).not.toBe(digestOf(before.bundle));
    expect(after.bundle.exceptions).toEqual([expect.objectContaining({ grantId, scope: "user", serviceId: "openai-chatgpt", ruleId: tfn.ruleId })]);

    const mine = await agentDoor(registry, "GET", `/requests/${laptop.deviceId}`, laptop.token);
    expect(mine.status, mine.text).toBe(200);
    expect(GuardAsksResponse.parse(mine.body).requests).toEqual([
      expect.objectContaining({ requestId: ask.request.requestId, status: "approved", grantExpiresAt: after.bundle.exceptions[0]?.expiresAt }),
    ]);

    const secondLaptop = await enrolDevice(registry, owner, member, "member-mini");
    expect((await bundleOf(secondLaptop)).bundle.exceptions).toEqual([expect.objectContaining({ grantId, scope: "user", serviceId: "openai-chatgpt" })]);
    const deeLaptop = await enrolDevice(registry, owner, dee, "dee-mbp");
    expect((await bundleOf(deeLaptop)).bundle.exceptions).toEqual([]);

    const revoked = await registry.consoleWrite(admin, "POST", `/policy-grants/${grantId}/revoke`, {});
    expect(revoked.status, revoked.text).toBe(200);
    expect((await bundleOf(laptop)).bundle.exceptions).toEqual([]);
  });
});

describe("eventupload", () => {
  it("rejects a row carrying a body by id, stores a duplicate once, and drops a snippet that still looks raw", async () => {
    const laptop = await enrolDevice(registry, owner, dee, "dee-air");
    const ok = eventId();
    const bodied = eventId();
    const raw = eventId();
    const base = {
      occurredAt: new Date().toISOString(),
      kind: "content",
      action: "blocked",
      serviceId: "openai-chatgpt",
      host: "chatgpt.com",
      app: { name: "Google Chrome" },
      matchType: "au-tfn",
      matchCount: 1,
    };
    const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      events: [
        { ...base, eventId: ok, snippet: "123***782" },
        { ...base, eventId: bodied, body: "My TFN is 123 456 782" },
        { ...base, eventId: raw, snippet: "123 456 782" },
        { ...base, eventId: "not-an-id" },
      ],
    });
    expect(up.status, up.text).toBe(200);
    const uploaded = GuardEventUploadResponse.parse(up.body);
    expect(uploaded.accepted).toBe(2);
    expect(uploaded.rejected).toEqual([expect.objectContaining({ eventId: bodied })]);
    const dup = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      events: [{ ...base, eventId: ok, snippet: "123***782" }],
    });
    expect(dup.body).toEqual({ accepted: 1, rejected: [] });

    const activity = await activityOf(laptop);
    expect(activity.rows.map((row) => row.eventId).sort()).toEqual([ok, raw].sort());
    expect(activity.rows.find((row) => row.eventId === ok)).toMatchObject({
      snippet: "123***782",
      serviceName: "ChatGPT",
      hostname: "dee-air",
      person: { email: dee.email },
    });
    expect(activity.rows.find((row) => row.eventId === raw)?.snippet).toBeUndefined();
    expect(activity.text).not.toMatch(MADE_UP_TFN_DIGITS);
  });

  it.each(["websocket-coverage", "http-coverage"])("accepts %s without inventing detector matches or dropping the batch", async (reason) => {
    const laptop = await enrolDevice(registry, owner, dee, `dee-${reason}`);
    const id = eventId();
    const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      events: [
        {
          eventId: id,
          occurredAt: new Date().toISOString(),
          kind: "flow",
          action: "blocked",
          serviceId: "xai-grok",
          host: "grok.com",
          method: reason === "http-coverage" ? "POST" : "WEBSOCKET",
          reason,
          bytes: 3,
        },
      ],
    });
    expect(up.body).toEqual({ accepted: 1, rejected: [] });
    const stored = required((await activityOf(laptop)).rows.find((row) => row.eventId === id), "the stored coverage event");
    expect(stored).toMatchObject({ ruleName: "Inspection unavailable", reason });
    expect(stored).not.toHaveProperty("matchType");
    expect(stored).not.toHaveProperty("ruleKind");
  });

  it("rejects by id an occurredAt that is not an instant and a snippet past 80 characters, and stores neither", async () => {
    const laptop = await enrolDevice(registry, owner, dee, "dee-edge");
    const notInstant = eventId();
    const long = eventId();
    const fine = eventId();
    const base = { kind: "content", action: "blocked", serviceId: "openai-chatgpt", host: "chatgpt.com" };
    const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      events: [
        { ...base, eventId: notInstant, occurredAt: "not-an-instant" },
        { ...base, eventId: long, occurredAt: new Date().toISOString(), snippet: `TFN ${"*".repeat(80)}` },
        { ...base, eventId: fine, occurredAt: new Date().toISOString(), snippet: "*".repeat(80) },
      ],
    });
    expect(up.status, up.text).toBe(200);
    const uploaded = GuardEventUploadResponse.parse(up.body);
    expect(uploaded.accepted).toBe(1);
    expect(uploaded.rejected).toEqual([
      { eventId: notInstant, reason: "occurredAt is not an instant" },
      expect.objectContaining({ eventId: long, reason: expect.stringContaining("snippet") }),
    ]);
    expect((await activityOf(laptop)).rows.map((row) => [row.eventId, row.snippet])).toEqual([[fine, "*".repeat(80)]]);
  });

  it("drops every snippet under snippetPolicy none, and round-trips a row with no optional field and a row with all of them", async () => {
    const laptop = await enrolDevice(registry, owner, dee, "dee-optional");
    await settings({ snippetPolicy: "none" });
    const bare = { eventId: eventId(), occurredAt: "2026-10-16T08:00:00.000Z", kind: "agent", action: "observed" };
    const full = {
      eventId: eventId(),
      occurredAt: "2026-10-16T08:00:01.000Z",
      kind: "content",
      action: "asked",
      serviceId: "openai-chatgpt",
      host: "chatgpt.com",
      port: 443,
      method: "POST",
      pathHint: "/backend-api",
      app: { bundleId: "com.google.Chrome", name: "Google Chrome", cli: "chrome", pid: 7 },
      ruleKind: "content",
      matchType: "au-tfn",
      matchCount: 2,
      snippet: "123***782",
      bytes: 2048,
      requestId: "preq_made_up",
      bundleVersion: 4,
      reason: "synced",
    };
    try {
      const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events: [bare, full] });
      expect(up.body).toEqual({ accepted: 2, rejected: [] });
      const { rows } = await activityOf(laptop);
      const registryOwn = ["deviceId", "hostname", "person", "receivedAt", "serviceName", "ruleName"];
      const agentPart = (id: string) =>
        Object.fromEntries(Object.entries(required(rows.find((row) => row.eventId === id), `the stored event ${id}`)).filter(([key]) => !registryOwn.includes(key)));
      expect(agentPart(bare.eventId)).toEqual(bare);
      const { snippet: _dropped, ...withoutSnippet } = full;
      expect(agentPart(full.eventId)).toEqual(withoutSnippet);
      expect(rows.find((row) => row.eventId === full.eventId)).toMatchObject({ serviceName: "ChatGPT", hostname: "dee-optional", person: { email: dee.email } });
      expect(rows.find((row) => row.eventId === bare.eventId)).not.toHaveProperty("serviceName");
    } finally {
      await settings({ snippetPolicy: "redacted" });
    }
  });
});

describe("refusals", () => {
  it("answers 401 to a missing or wrong bearer, 404 to an unknown device, 400 to a newer protocol, and 401 on every door once revoked", async () => {
    const laptop = await enrolDevice(registry, owner, dee, "dee-old");
    const other = await enrolDevice(registry, owner, member, "member-old");
    const id = laptop.deviceId;
    const missing = await agentDoor(registry, "POST", `/preflight/${id}`, undefined, preflightBody("dee-old"));
    expect([missing.status, missing.body]).toEqual([401, expect.objectContaining({ code: "GUARD_TOKEN_INVALID" })]);
    const wrong = await agentDoor(registry, "POST", `/preflight/${id}`, other.token, preflightBody("dee-old"));
    expect([wrong.status, wrong.body]).toEqual([401, expect.objectContaining({ code: "GUARD_TOKEN_INVALID" })]);
    const unknown = await agentDoor(registry, "POST", "/preflight/gdev_0123456789abcdef", laptop.token, preflightBody("dee-old"));
    expect([unknown.status, unknown.body]).toEqual([404, expect.objectContaining({ code: "GUARD_DEVICE_UNKNOWN" })]);
    const newer = await agentDoor(registry, "POST", `/preflight/${id}`, laptop.token, { ...preflightBody("dee-old"), protocol: GUARD_PROTOCOL_VERSION + 1 });
    expect([newer.status, newer.body]).toEqual([400, expect.objectContaining({ code: "GUARD_PROTOCOL_UNSUPPORTED" })]);

    const revoked = await registry.consoleWrite(admin, "POST", `/guard/devices/${id}/revoke`, {});
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body).toMatchObject({ status: "revoked", revokedBy: admin.email });
    const doors: Array<["GET" | "POST", string, unknown]> = [
      ["POST", `/preflight/${id}`, preflightBody("dee-old")],
      ["POST", `/ruledownload/${id}`, { protocol: GUARD_PROTOCOL_VERSION }],
      [
        "POST",
        `/eventupload/${id}`,
        { protocol: GUARD_PROTOCOL_VERSION, events: [{ eventId: eventId(), occurredAt: new Date().toISOString(), kind: "agent", action: "observed" }] },
      ],
      [
        "POST",
        `/postflight/${id}`,
        { protocol: GUARD_PROTOCOL_VERSION, bundleVersion: 1, catalogueVersion: "x", rulesReceived: 0, rulesProcessed: 0, clientMode: "monitor" },
      ],
      ["POST", `/requests/${id}`, { serviceId: "openai-chatgpt" }],
      ["GET", `/requests/${id}`, undefined],
    ];
    for (const [method, doorPath, body] of doors) {
      const reply = await agentDoor(registry, method, doorPath, laptop.token, body);
      expect([doorPath, reply.status, reply.body]).toEqual([doorPath, 401, expect.objectContaining({ code: "GUARD_DEVICE_REVOKED" })]);
    }
  });

  it("uses an enrol token once, binds it to the person it was minted for, and mints no link for a non-member", async () => {
    const link = await mintEnrolLink(registry, owner, dee, { note: "Dee's laptop" });
    expect(link.url).toMatch(/^vibtra-guard:\/\/enrol\?server=http%3A%2F%2Fregistry\.test\.local&token=genr_[0-9a-f]{32}$/);
    const first = await agentDoor(registry, "POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.token, device: facts("dee-new"), ca: CA });
    expect(first.status, first.text).toBe(201);
    const enrolled = GuardEnrolResponse.parse(first.body);
    expect(enrolled.person.email).toBe(dee.email);
    const second = await agentDoor(registry, "POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.token, device: facts("someone-else"), ca: CA });
    expect([second.status, second.body]).toEqual([400, expect.objectContaining({ code: "GUARD_ENROL_TOKEN_INVALID" })]);
    const stranger = await registry.consoleWrite(owner, "POST", "/guard/devices/enrol-links", { personEmail: "eve@elsewhere.example" });
    expect(stranger.status).toBe(400);

    const links = await registry.consoleGet(owner, "/guard/devices/enrol-links");
    expect(links.status, links.text).toBe(200);
    expect(GuardEnrolLinksPage.parse(links.body).rows.find((row) => row.note === "Dee's laptop")).toMatchObject({ personEmail: dee.email, usedByDevice: enrolled.deviceId });
    expect(links.text).not.toContain(link.token);
  });

  it("answers 404 to another organisation's admin, and 403 on the ask door when requests are off", async () => {
    const laptop = await enrolDevice(registry, owner, member, "member-third");
    const outsider = await registry.join("zed", "other-org.example");
    const foreign = await registry.consoleWrite(outsider, "POST", `/guard/devices/${laptop.deviceId}/revoke`, {});
    expect(foreign.status, foreign.text).toBe(404);
    const stillSyncing = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-third"));
    expect(stillSyncing.status, stillSyncing.text).toBe(200);

    await settings({ requestsEnabled: false });
    try {
      const refused = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect([refused.status, refused.body]).toEqual([403, expect.objectContaining({ code: "GUARD_REQUESTS_OFF" })]);
    } finally {
      await settings({ requestsEnabled: true });
    }
  });
});

describe("the ask door's refusals", () => {
  it("answers a policy desk refusal with the desk's own status and code, and stores no ask", async () => {
    const laptop = await enrolDevice(registry, owner, member, "member-funnel");
    const reply = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, {
      serviceId: "deepseek",
      note: "it is in the Authorization: line of the mail",
    });
    expect([reply.status, reply.body]).toEqual([400, { code: "VALIDATION", message: "why must not carry a secret" }]);
    const asks = await agentDoor(registry, "GET", `/requests/${laptop.deviceId}`, laptop.token);
    expect(GuardAsksResponse.parse(asks.body).requests.filter((ask) => ask.subject.serviceId === "deepseek")).toEqual([]);
  });

  it("refuses a service outside the catalogue and a body field the contract does not have", async () => {
    const laptop = await enrolDevice(registry, owner, member, "member-strict");
    const unknown = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "not-in-the-catalogue" });
    expect([unknown.status, unknown.body]).toEqual([400, expect.objectContaining({ code: "VALIDATION" })]);
    const extra = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek", text: "my tfn is in here" });
    expect([extra.status, extra.body]).toEqual([400, expect.objectContaining({ code: "VALIDATION" })]);
    const asks = await agentDoor(registry, "GET", `/requests/${laptop.deviceId}`, laptop.token);
    expect(GuardAsksResponse.parse(asks.body).requests.filter((ask) => ask.subject.deviceId === laptop.deviceId)).toEqual([]);
  });
});

describe("the Guard doors' error funnel (Postgres)", () => {
  it("re-throws a desk store failure to the registry's handler, whose 500 answers a generic code and message", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    let storage: Storage | undefined;
    const broken = await startRegistry({ domain: "guard-funnel.example", configure: capturingStorage((captured) => (storage = captured)) });
    try {
      const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
      const laptop = await enrolDevice(broken, broken.people.owner, broken.people.member, "member-broken-store");
      const asked = await agentDoor(broken, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect([200, 201], asked.text).toContain(asked.status);

      await sqlRows(databaseUrl, "ALTER TABLE policy_requests RENAME TO policy_requests_moved_aside");
      try {
        const replies = [
          await agentDoor(broken, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "openai-chatgpt" }),
          await agentDoor(broken, "GET", `/requests/${laptop.deviceId}`, laptop.token),
          await broken.consoleGet(broken.people.owner, "/guard/overview"),
        ];
        for (const reply of replies) {
          expect([reply.status, reply.body]).toEqual([500, { code: "INTERNAL", message: "Something went wrong" }]);
          expect(reply.text).not.toMatch(/policy_requests|relation|does not exist/);
        }
      } finally {
        await sqlRows(databaseUrl, "ALTER TABLE policy_requests_moved_aside RENAME TO policy_requests");
      }
      const healed = await agentDoor(broken, "GET", `/requests/${laptop.deviceId}`, laptop.token);
      expect(healed.status, healed.text).toBe(200);
      expect(GuardAsksResponse.parse(healed.body).requests.map((row) => row.subject.serviceId)).toEqual(["deepseek"]);
    } finally {
      await broken.close();
    }
  });
});
