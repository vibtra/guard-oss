import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION, GUARD_STARTER_CONTENT_RULES, GuardAskResponse, GuardAsksResponse, GuardRuleDownloadResponse } from "@vibtra/guard-contract";
import { digestOf, verifyGuardBundle } from "@vibtra/guard-contract/signing";
import { startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, grantOf, required, type EnrolledDevice } from "./guard-device.ts";
import { capturingStorage, manualClock, postgresMissing, sqlRows, withHosted, type Storage } from "./server-options.ts";

type Json = Record<string, any>;

const START = "2026-10-16T09:00:00.000Z";
const clock = manualClock(new Date(START));

let registry: TestRegistry;
let owner: Person;
let admin: Person;
let member: Person;
let tfnRuleId: string;

const ask = async (laptop: EnrolledDevice, body: Json) => {
  const reply = await agentDoor(registry, "POST", `/requests/${laptop.deviceId}`, laptop.token, body);
  expect([200, 201], reply.text).toContain(reply.status);
  return GuardAskResponse.parse(reply.body);
};

const approve = (requestId: string, body: Json = {}) => registry.consoleWrite(admin, "POST", `/policy-requests/${requestId}/approve`, body);

const deskRows = async (query: string): Promise<Json[]> => {
  const reply = await registry.consoleGet(admin, `/policy-requests?${query}`);
  expect(reply.status, reply.text).toBe(200);
  return (reply.body as { requests: Json[] }).requests;
};

const grantRow = async (grantId: string): Promise<Json | undefined> => {
  const reply = await registry.consoleGet(admin, "/policy-grants");
  expect(reply.status, reply.text).toBe(200);
  return (reply.body as { grants: Json[] }).grants.find((grant) => grant.id === grantId);
};

const download = async (laptop: EnrolledDevice) => {
  const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
  expect(reply.status, reply.text).toBe(200);
  const parsed = GuardRuleDownloadResponse.parse(reply.body);
  return required(parsed.bundle, "a bundle").bundle;
};

beforeAll(async () => {
  registry = await startRegistry({ domain: "guard-asks.example", configure: (options) => ({ ...options, clock }) });
  ({ owner, admin, member } = registry.people);
  const rules = await registry.consoleWrite(owner, "PUT", "/guard/rules", {
    baseVersion: 0,
    document: {
      defaultAction: "allow",
      serviceRules: [],
      contentRules: GUARD_STARTER_CONTENT_RULES.map((rule) => ({ ...rule, services: "*", audience: { kind: "org" }, enabled: true })),
    },
  });
  if (rules.status !== 200) throw new Error(`saving the rules answered ${rules.status}: ${rules.text.slice(0, 300)}`);
  tfnRuleId = required(
    (rules.body as { document: { contentRules: Array<{ ruleId: string; name: string }> } }).document.contentRules.find((rule) => rule.name === "Tax file numbers"),
    "the starter TFN rule",
  ).ruleId;
});

afterAll(async () => {
  await registry?.close();
});

describe("a guard ask on the policy desk", () => {
  it("is keyed by the person, its words name the service and the rule, and a second person gets their own row", async () => {
    const ownerLaptop = await enrolDevice(registry, admin, owner, "owner-keyed");
    const memberLaptop = await enrolDevice(registry, admin, member, "member-keyed");
    const first = await ask(ownerLaptop, { serviceId: "openai-chatgpt", ruleId: tfnRuleId, matchType: "au-tfn", note: "Made-up reason: the fictional audit needs it" });
    expect(first).toMatchObject({ created: true, request: { kind: "guard", status: "pending" } });
    const again = await ask(ownerLaptop, { serviceId: "openai-chatgpt", ruleId: tfnRuleId });
    expect(again.created).toBe(false);
    expect(again.request.requestId).toBe(first.request.requestId);
    const fromMember = await ask(memberLaptop, { serviceId: "openai-chatgpt", ruleId: tfnRuleId });
    expect(fromMember.created).toBe(true);
    expect(fromMember.request.requestId).not.toBe(first.request.requestId);
    const flow = await ask(ownerLaptop, { serviceId: "deepseek" });
    expect(flow.created).toBe(true);

    const rows = await deskRows("kind=guard");
    expect(rows).toHaveLength(3);
    const byId = (id: string) => required(rows.find((row) => row.id === id), `the desk row ${id}`);
    expect(byId(first.request.requestId)).toMatchObject({
      kind: "guard",
      status: "pending",
      subjectKey: `openai-chatgpt/${tfnRuleId}@${owner.userId}`,
      words: 'sending what the rule "Tax file numbers" blocks to ChatGPT',
    });
    expect(byId(fromMember.request.requestId).subjectKey).toBe(`openai-chatgpt/${tfnRuleId}@${member.userId}`);
    expect(byId(flow.request.requestId)).toMatchObject({ subjectKey: `deepseek/*@${owner.userId}`, words: "using DeepSeek from their laptop" });
    const detail = await registry.consoleGet(admin, `/policy-requests/${first.request.requestId}`);
    expect(detail.status, detail.text).toBe(200);
    expect(JSON.stringify(rows) + detail.text).not.toContain("fictional audit");
  });

  it("approves as a user grant of kind guard, 7 days by default and at most 90, ends it after its time, and revokes", async () => {
    const asker = await registry.join("ada");
    const laptop = await enrolDevice(registry, admin, asker, "ada-grant");
    const asked = await ask(laptop, { serviceId: "openai-chatgpt", ruleId: tfnRuleId });
    const tooLong = await approve(asked.request.requestId, { grant: { days: 91 } });
    expect([tooLong.status, (tooLong.body as Json).code]).toEqual([400, "VALIDATION"]);
    const both = await approve(asked.request.requestId, { grant: { days: 1, hours: 1 } });
    expect([both.status, (both.body as Json).code]).toEqual([400, "VALIDATION"]);
    const approved = await approve(asked.request.requestId);
    expect(approved.status, approved.text).toBe(200);
    expect((approved.body as Json).request.status).toBe("approved");
    const grant = grantOf(approved.body);
    expect(grant).toMatchObject({
      kind: "guard",
      scope: "user",
      userId: asker.userId,
      subject: { serviceId: "openai-chatgpt", ruleId: tfnRuleId, deviceId: laptop.deviceId },
      expiresAt: new Date(clock.now().getTime() + 7 * 24 * 3_600_000).toISOString(),
    });
    expect(await grantRow(grant.id)).toMatchObject({ kind: "guard", live: true });
    clock.advance(8 * 24 * 3_600_000);
    expect(await grantRow(grant.id)).toMatchObject({ live: false });
    expect((await download(laptop)).exceptions).toEqual([]);

    const later = await ask(laptop, { serviceId: "deepseek" });
    const hours = await approve(later.request.requestId, { grant: { hours: 8 } });
    expect(hours.status, hours.text).toBe(200);
    const eight = grantOf(hours.body);
    expect(eight.expiresAt).toBe(new Date(clock.now().getTime() + 8 * 3_600_000).toISOString());
    const revoked = await registry.consoleWrite(admin, "POST", `/policy-grants/${eight.id}/revoke`, {});
    expect(revoked.status, revoked.text).toBe(200);
    expect((revoked.body as Json).grant).toMatchObject({ id: eight.id, revokedBy: admin.userId });
    expect(await grantRow(eight.id)).toMatchObject({ live: false });
    const twice = await registry.consoleWrite(admin, "POST", `/policy-grants/${eight.id}/revoke`, {});
    expect([twice.status, (twice.body as Json).code]).toEqual([409, "GRANT_REVOKED"]);
  });

  it("refuses an approval whose note carries a secret, and the ask stays pending", async () => {
    const laptop = await enrolDevice(registry, admin, member, "member-note");
    const asked = (await ask(laptop, { serviceId: "mistral" })).request.requestId;
    const refused = await approve(asked, { note: "it is in the Authorization: line of the mail" });
    expect([refused.status, (refused.body as Json).code]).toEqual([400, "VALIDATION"]);
    expect((refused.body as Json).message).toContain("carries no secret");
    const after = await registry.consoleGet(admin, `/policy-requests/${asked}`);
    expect(after.status, after.text).toBe(200);
    expect((after.body as Json).request).toMatchObject({ id: asked, status: "pending" });
    expect(JSON.stringify(after.body)).not.toContain("Authorization");
  });

  it("refuses to approve a declined or an approved ask with 409 REQUEST_DECIDED, adds no grant and keeps its status", async () => {
    const laptop = await enrolDevice(registry, admin, member, "member-decided");
    const grantsFor = async (requestId: string) => {
      const reply = await registry.consoleGet(admin, "/policy-grants");
      expect(reply.status, reply.text).toBe(200);
      return (reply.body as { grants: Json[] }).grants.filter((grant) => grant.requestId === requestId);
    };
    const statusOf = async (requestId: string) => ((await registry.consoleGet(admin, `/policy-requests/${requestId}`)).body as Json).request.status;

    const declinedId = (await ask(laptop, { serviceId: "perplexity" })).request.requestId;
    const declined = await registry.consoleWrite(admin, "POST", `/policy-requests/${declinedId}/decline`, {});
    expect(declined.status, declined.text).toBe(200);
    const afterDecline = await approve(declinedId);
    expect([afterDecline.status, (afterDecline.body as Json).code]).toEqual([409, "REQUEST_DECIDED"]);
    expect(await grantsFor(declinedId)).toEqual([]);
    expect(await statusOf(declinedId)).toBe("declined");
    expect((await download(laptop)).exceptions).toEqual([]);

    const approvedId = (await ask(laptop, { serviceId: "deepseek" })).request.requestId;
    const first = await approve(approvedId);
    expect(first.status, first.text).toBe(200);
    const again = await approve(approvedId);
    expect([again.status, (again.body as Json).code]).toEqual([409, "REQUEST_DECIDED"]);
    expect(await grantsFor(approvedId)).toHaveLength(1);
    expect(await statusOf(approvedId)).toBe("approved");
  });
});

describe("a guard grant's time-box", () => {
  it("takes 1 to 23 whole hours on the hours arm, and refuses 0, 24, a fraction and a negative while the ask stays pending", async () => {
    const asker = await registry.join("bea");
    const laptop = await enrolDevice(registry, admin, asker, "bea-hours");
    const otherLaptop = await enrolDevice(registry, admin, member, "member-hours");
    const now = clock.now().getTime();
    const one = await approve((await ask(laptop, { serviceId: "openai-chatgpt" })).request.requestId, { grant: { hours: 1 } });
    expect(grantOf(one.body).expiresAt).toBe(new Date(now + 3_600_000).toISOString());
    const most = await approve((await ask(otherLaptop, { serviceId: "openai-chatgpt" })).request.requestId, { grant: { hours: 23 } });
    expect(grantOf(most.body).expiresAt).toBe(new Date(now + 23 * 3_600_000).toISOString());
    const pending = (await ask(laptop, { serviceId: "deepseek" })).request.requestId;
    for (const hours of [0, 24, 1.5, -1]) {
      const refused = await approve(pending, { grant: { hours } });
      expect([hours, refused.status, (refused.body as Json).code]).toEqual([hours, 400, "VALIDATION"]);
    }
    const stillPending = (await deskRows("kind=guard&status=pending")).filter((row) => row.subjectKey?.endsWith(`@${asker.userId}`));
    expect(stillPending.map((row) => row.id)).toEqual([pending]);
  });

  it("drops the laptop's exception and reverts the bundle digest at the exact instant the grant ends", async () => {
    const laptop = await enrolDevice(registry, admin, owner, "owner-expiry");
    const before = await download(laptop);
    expect(before.exceptions).toEqual([]);
    const asked = await ask(laptop, { serviceId: "anthropic-claude", app: "Safari", note: "Made-up reason: the vendor review" });
    expect(asked).toMatchObject({ created: true, request: { status: "pending", subject: { serviceId: "anthropic-claude", deviceId: laptop.deviceId } } });
    const approved = await approve(asked.request.requestId, { grant: { hours: 1 } });
    const grant = grantOf(approved.body);
    const expiresAt = required(grant.expiresAt as string | undefined, "the grant's end");
    expect(expiresAt).toBe(new Date(clock.now().getTime() + 3_600_000).toISOString());

    const during = await download(laptop);
    expect(during.exceptions).toEqual([{ grantId: grant.id, scope: "user", serviceId: "anthropic-claude", expiresAt }]);
    expect(digestOf(during)).not.toBe(digestOf(before));
    const mine = await agentDoor(registry, "GET", `/requests/${laptop.deviceId}`, laptop.token);
    expect(GuardAsksResponse.parse(mine.body).requests.find((row) => row.requestId === asked.request.requestId)).toMatchObject({
      status: "approved",
      grantExpiresAt: expiresAt,
    });

    clock.set(new Date(new Date(expiresAt).getTime() - 1).toISOString());
    expect((await download(laptop)).exceptions).toHaveLength(1);
    clock.set(expiresAt);
    expect(await grantRow(grant.id)).toMatchObject({ live: false });
    const after = await download(laptop);
    expect(after.exceptions).toEqual([]);
    expect(digestOf(after)).toBe(digestOf(before));
  });
});

describe("the policy desk for a member", () => {
  it("answers 403 admin_only on list, detail, approve, decline, grants and revoke, and leaves their own ask pending and the grant live", async () => {
    const laptop = await enrolDevice(registry, admin, member, "member-desk");
    const own = (await ask(laptop, { serviceId: "deepseek" })).request.requestId;
    const granted = await approve((await ask(laptop, { serviceId: "anthropic-claude" })).request.requestId);
    expect(granted.status, granted.text).toBe(200);
    const grant = grantOf(granted.body);
    const replies = [
      await registry.consoleGet(member, "/policy-requests"),
      await registry.consoleGet(member, `/policy-requests/${own}`),
      await registry.consoleWrite(member, "POST", `/policy-requests/${own}/approve`, {}),
      await registry.consoleWrite(member, "POST", `/policy-requests/${own}/decline`, {}),
      await registry.consoleGet(member, "/policy-grants"),
      await registry.consoleWrite(member, "POST", `/policy-grants/${grant.id}/revoke`, {}),
    ];
    expect(replies.map((reply) => [reply.status, (reply.body as Json).code])).toEqual(Array.from({ length: 6 }, () => [403, "admin_only"]));
    const after = await registry.consoleGet(admin, `/policy-requests/${own}`);
    expect(after.status, after.text).toBe(200);
    expect(JSON.stringify(after.body)).toContain('"status":"pending"');
    expect(await grantRow(grant.id)).toMatchObject({ live: true });
  });
});

describe("the policy desk for another organisation's admin", () => {
  it("answers 404 on detail, approve, decline and revoke, and leaves the ask pending and the grant live", async () => {
    const laptop = await enrolDevice(registry, admin, member, "member-outsider");
    const own = (await ask(laptop, { serviceId: "perplexity" })).request.requestId;
    const granted = await approve((await ask(laptop, { serviceId: "google-gemini" })).request.requestId);
    expect(granted.status, granted.text).toBe(200);
    const grant = grantOf(granted.body);
    const outsider = await registry.join("oscar", "guard-asks-other.example");
    const replies = [
      await registry.consoleGet(outsider, `/policy-requests/${own}`),
      await registry.consoleWrite(outsider, "POST", `/policy-requests/${own}/approve`, {}),
      await registry.consoleWrite(outsider, "POST", `/policy-requests/${own}/decline`, {}),
      await registry.consoleWrite(outsider, "POST", `/policy-grants/${grant.id}/revoke`, {}),
    ];
    expect(replies.map((reply) => [reply.status, (reply.body as Json).code])).toEqual([
      [404, "REQUEST_NOT_FOUND"],
      [404, "REQUEST_NOT_FOUND"],
      [404, "REQUEST_NOT_FOUND"],
      [404, "GRANT_NOT_FOUND"],
    ]);
    const listed = await registry.consoleGet(outsider, "/policy-requests");
    expect(listed.status, listed.text).toBe(200);
    expect((listed.body as { requests: Json[] }).requests).toEqual([]);
    const after = await registry.consoleGet(admin, `/policy-requests/${own}`);
    expect(after.status, after.text).toBe(200);
    expect((after.body as Json).request).toMatchObject({ id: own, status: "pending" });
    expect(await grantRow(grant.id)).toMatchObject({ live: true });
  });
});

describe("a guard ask's expiry", () => {
  it("shows expired to the laptop and the desk after 14 days, refuses approval with 409 REQUEST_EXPIRED, and mails nobody on a re-ask within a day", async () => {
    const sent: Json[] = [];
    const expiryClock = manualClock(new Date(START));
    const mailing = await startRegistry({
      domain: "guard-ask-expiry.example",
      configure: (options) =>
        withHosted((hosted) => ({ ...hosted, resendApiKey: "re_test_FAKE_not_a_key", mailFrom: "Guard <no-reply@guard-ask-expiry.example>" }))({
          ...options,
          clock: expiryClock,
          mailFetch: async (_url: string, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)) as Json);
            return new Response(JSON.stringify({ id: "made-up-mail-id" }), { status: 200, headers: { "content-type": "application/json" } });
          },
        }),
    });
    try {
      const { admin: approver, member: asker } = mailing.people;
      const laptop = await enrolDevice(mailing, approver, asker, "member-expiry");
      const first = await agentDoor(mailing, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect(first.status, first.text).toBe(201);
      const requestId = GuardAskResponse.parse(first.body).request.requestId;
      expect(sent).toHaveLength(2);

      expiryClock.advance(14 * 24 * 3_600_000 - 1);
      const mineBefore = await agentDoor(mailing, "GET", `/requests/${laptop.deviceId}`, laptop.token);
      expect(GuardAsksResponse.parse(mineBefore.body).requests.find((row) => row.requestId === requestId)?.status).toBe("pending");

      expiryClock.advance(3_600_000);
      const mine = await agentDoor(mailing, "GET", `/requests/${laptop.deviceId}`, laptop.token);
      expect(mine.status, mine.text).toBe(200);
      expect(GuardAsksResponse.parse(mine.body).requests.find((row) => row.requestId === requestId)?.status).toBe("expired");
      const desk = await mailing.consoleGet(approver, "/policy-requests?kind=guard");
      expect(desk.status, desk.text).toBe(200);
      expect((desk.body as { requests: Json[] }).requests.find((row) => row.id === requestId)).toMatchObject({ status: "expired" });
      const late = await mailing.consoleWrite(approver, "POST", `/policy-requests/${requestId}/approve`, {});
      expect([late.status, (late.body as Json).code]).toEqual([409, "REQUEST_EXPIRED"]);

      const again = await agentDoor(mailing, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect(again.status, again.text).toBe(201);
      expect(GuardAskResponse.parse(again.body)).toMatchObject({ created: true, request: { status: "pending" } });
      expect(GuardAskResponse.parse(again.body).request.requestId).not.toBe(requestId);
      expect(sent).toHaveLength(2);
    } finally {
      await mailing.close();
    }
  });
});

describe("a guard grant written outside the desk (Postgres)", () => {
  it("is skipped when malformed, not live or of another kind without failing the download, and a live grant's extra subject fields stay out of the signed bundle", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    let storage: Storage | undefined;
    const isolated = await startRegistry({ domain: "guard-grant-rows.example", configure: capturingStorage((captured) => (storage = captured)) });
    try {
      const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
      const { admin: approver, member: asker } = isolated.people;
      const laptop = await enrolDevice(isolated, approver, asker, "member-grant-rows");
      const asked = await agentDoor(isolated, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "anthropic-claude" });
      expect([200, 201], asked.text).toContain(asked.status);
      const approved = await isolated.consoleWrite(approver, "POST", `/policy-requests/${GuardAskResponse.parse(asked.body).request.requestId}/approve`, {});
      expect(approved.status, approved.text).toBe(200);
      const grant = grantOf(approved.body);
      const expiresAt = required(grant.expiresAt as string | undefined, "the grant's end");

      const [real] = await sqlRows<{ org_id: string }>(databaseUrl, "UPDATE policy_grants SET subject = subject || $2::jsonb WHERE id = $1 RETURNING org_id", [grant.id, JSON.stringify({ extra: "kept out" })]);
      const orgId = required(real, "the real grant row").org_id;
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const inADay = new Date(Date.now() + 24 * 3_600_000).toISOString();
      const planted: Array<{ kind: string; subject: Json; expiresAt?: string; revokedAt?: string }> = [
        { kind: "guard", subject: {} },
        { kind: "guard", subject: { serviceId: "" } },
        { kind: "guard", subject: { serviceId: "deepseek", ruleId: 7 } },
        { kind: "guard", subject: { serviceId: "deepseek" }, expiresAt: hourAgo },
        { kind: "guard", subject: { serviceId: "deepseek" }, expiresAt: inADay, revokedAt: hourAgo },
        { kind: "egress-host", subject: { serviceId: "deepseek", host: "api.deepseek.example" }, expiresAt: inADay },
      ];
      for (const [index, row] of planted.entries()) {
        const suffix = (0xa0 + index).toString(16).padStart(20, "0");
        await sqlRows(
          databaseUrl,
          "INSERT INTO policy_grants (id, org_id, scope, user_id, kind, subject, subject_key, expires_at, request_id, approved_by, revoked_at, revoked_by) VALUES ($1, $2, 'user', $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)",
          [
            `pgr_${suffix}`,
            orgId,
            asker.userId,
            row.kind,
            JSON.stringify(row.subject),
            `planted-${index}@${asker.userId}`,
            row.expiresAt ?? null,
            `preq_${suffix}`,
            approver.userId,
            row.revokedAt ?? null,
            row.revokedAt === undefined ? null : approver.userId,
          ],
        );
      }

      const reply = await agentDoor(isolated, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect(reply.status, reply.text).toBe(200);
      const signed = required(GuardRuleDownloadResponse.parse(reply.body).bundle, "a bundle");
      expect(signed.bundle.exceptions).toEqual([{ grantId: grant.id, scope: "user", serviceId: "anthropic-claude", expiresAt }]);
      expect(reply.text).not.toContain("kept out");
      expect(verifyGuardBundle(signed, laptop.enrol.signing.publicKeyPem, laptop.enrol.signing.keyId, laptop.deviceId)).toMatchObject({ ok: true });
      const stored = await sqlRows<{ subject: Json }>(databaseUrl, "SELECT subject FROM policy_grants WHERE id = $1", [grant.id]);
      expect(stored).toEqual([{ subject: expect.objectContaining({ serviceId: "anthropic-claude", extra: "kept out" }) }]);
    } finally {
      await isolated.close();
    }
  });
});

describe("a guard approval's audit line (Postgres)", () => {
  it("writes policy.request.decided as allowed on approve and refused on decline", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    let storage: Storage | undefined;
    const isolated = await startRegistry({ domain: "guard-approval-audit.example", configure: capturingStorage((captured) => (storage = captured)) });
    try {
      const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
      const { admin: approver, member: asker } = isolated.people;
      const laptop = await enrolDevice(isolated, approver, asker, "member-audit");
      const asked = await agentDoor(isolated, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "anthropic-claude" });
      expect([200, 201], asked.text).toContain(asked.status);
      const approved = await isolated.consoleWrite(approver, "POST", `/policy-requests/${GuardAskResponse.parse(asked.body).request.requestId}/approve`, {});
      expect(approved.status, approved.text).toBe(200);
      const grant = grantOf(approved.body);
      const declineAsk = await agentDoor(isolated, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect([200, 201], declineAsk.text).toContain(declineAsk.status);
      const declined = await isolated.consoleWrite(approver, "POST", `/policy-requests/${GuardAskResponse.parse(declineAsk.body).request.requestId}/decline`, {});
      expect(declined.status, declined.text).toBe(200);
      const rows = await sqlRows<{ event: string; actor: string; outcome: string; detail: string }>(databaseUrl, "SELECT event, actor, outcome, detail FROM vault_audit ORDER BY seq");
      expect(rows.filter((row) => row.event === "policy.request.decided")).toEqual([
        { event: "policy.request.decided", actor: approver.email, outcome: "allowed", detail: expect.stringContaining(`guard anthropic-claude/*@${asker.userId} approved as grant ${grant.id}`) },
        { event: "policy.request.decided", actor: approver.email, outcome: "refused", detail: expect.stringContaining(`guard deepseek/*@${asker.userId} declined`) },
      ]);
    } finally {
      await isolated.close();
    }
  });
});

describe("a guard ask's arrival mail", () => {
  it("mails every admin but the asker, names the service, stays quiet on a re-ask within a day of a decline, and skips an asking admin", async () => {
    const sent: Json[] = [];
    const mailing = await startRegistry({
      domain: "guard-ask-mail.example",
      configure: (options) =>
        withHosted((hosted) => ({ ...hosted, resendApiKey: "re_test_FAKE_not_a_key", mailFrom: "Guard <no-reply@guard-ask-mail.example>" }))({
          ...options,
          mailFetch: async (_url: string, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)) as Json);
            return new Response(JSON.stringify({ id: "made-up-mail-id" }), { status: 200, headers: { "content-type": "application/json" } });
          },
        }),
    });
    try {
      const { owner: boss, admin: approver, member: asker } = mailing.people;
      const laptop = await enrolDevice(mailing, approver, asker, "member-mail");
      const first = await agentDoor(mailing, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect(first.status, first.text).toBe(201);
      const requestId = GuardAskResponse.parse(first.body).request.requestId;
      expect(sent.map((mail) => mail.to).sort()).toEqual([[approver.email], [boss.email]].sort());
      for (const mail of sent) {
        expect(mail.subject).toBe(`${asker.email} asked IT for using DeepSeek from their laptop`);
        expect(String(mail.text)).toContain(`/requests/policy/${requestId}`);
      }

      const declined = await mailing.consoleWrite(approver, "POST", `/policy-requests/${requestId}/decline`, {});
      expect(declined.status, declined.text).toBe(200);
      const again = await agentDoor(mailing, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect(again.status, again.text).toBe(201);
      expect(GuardAskResponse.parse(again.body).created).toBe(true);
      expect(sent).toHaveLength(2);

      const adminLaptop = await enrolDevice(mailing, approver, approver, "admin-mail");
      const adminAsk = await agentDoor(mailing, "POST", `/requests/${adminLaptop.deviceId}`, adminLaptop.token, { serviceId: "openai-chatgpt" });
      expect(adminAsk.status, adminAsk.text).toBe(201);
      expect(sent.slice(2).map((mail) => mail.to)).toEqual([[boss.email]]);
      expect(sent[2]?.subject).toBe(`${approver.email} asked IT for using ChatGPT from their laptop`);
    } finally {
      await mailing.close();
    }
  });
});

describe("a request row from the retired workspace platform (Postgres)", () => {
  it("still lists with its words but is not approved by the Guard desk", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    let storage: Storage | undefined;
    const isolated = await startRegistry({ domain: "guard-legacy-rows.example", configure: capturingStorage((captured) => (storage = captured)) });
    try {
      const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
      const { admin: approver, member: asker } = isolated.people;
      const laptop = await enrolDevice(isolated, approver, asker, "member-legacy-rows");
      const asked = await agentDoor(isolated, "POST", `/requests/${laptop.deviceId}`, laptop.token, { serviceId: "deepseek" });
      expect([200, 201], asked.text).toContain(asked.status);
      const [real] = await sqlRows<{ org_id: string }>(databaseUrl, "SELECT org_id FROM policy_requests WHERE id = $1", [GuardAskResponse.parse(asked.body).request.requestId]);
      const orgId = required(real, "the guard ask row").org_id;
      const legacyId = `preq_${"b".repeat(20)}`;
      const at = new Date();
      await sqlRows(
        databaseUrl,
        "INSERT INTO policy_requests (id, org_id, requester_user_id, kind, subject, subject_key, status, reminder_at, expires_at, created_at) VALUES ($1, $2, $3, 'egress-host', $4::jsonb, 'api.example.com:443', 'pending', $5, $6, $7)",
        [legacyId, orgId, asker.userId, JSON.stringify({ host: "api.example.com", port: 443 }), new Date(at.getTime() + 7 * 86_400_000).toISOString(), new Date(at.getTime() + 14 * 86_400_000).toISOString(), at.toISOString()],
      );
      const listed = await isolated.consoleGet(approver, "/policy-requests");
      expect(listed.status, listed.text).toBe(200);
      expect((listed.body as { requests: Json[] }).requests.find((row) => row.id === legacyId)).toMatchObject({ kind: "egress-host", words: "network access to api.example.com" });
      const refused = await isolated.consoleWrite(approver, "POST", `/policy-requests/${legacyId}/approve`, {});
      expect([refused.status, (refused.body as Json).code]).toEqual([409, "REQUEST_NOT_GUARD"]);
      const declined = await isolated.consoleWrite(approver, "POST", `/policy-requests/${legacyId}/decline`, {});
      expect(declined.status, declined.text).toBe(200);
    } finally {
      await isolated.close();
    }
  });
});
