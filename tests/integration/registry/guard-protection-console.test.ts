import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_API_PREFIX } from "@vibtra/console-api";
import {
  GUARD_PROTOCOL_VERSION,
  GuardPreflightResponse,
  GuardProtectionApplied,
  GuardProtectionPage,
  GuardProtectionPreview,
  GuardProtectionRollout,
  GuardRuleDownloadResponse,
  GuardSettingsPage,
  type GuardClientMode,
  type GuardDeviceFacts,
  type SignedGuardBundle,
} from "@vibtra/guard-contract";
import { digestOf } from "@vibtra/guard-contract/signing";
import { REGISTRY_ORIGIN, startRegistry, type ConsoleReply, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, facts, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";
import { postgresMissing } from "./server-options.ts";

const P = "/people/protection";
const CAN_TURN_OFF: Partial<GuardDeviceFacts> = { capabilities: { protectionOff: 1 } };

type Change = { userIds: string[]; mode: GuardClientMode } | { userIds: string[]; clear: true } | { default: GuardClientMode };

const TWINS = [
  { name: "JSON file", postgres: false },
  { name: "Postgres", postgres: true },
] as const;

for (const twin of TWINS) {
  describe.skipIf(twin.postgres && postgresMissing())(`each person's protection on the console (${twin.name})`, () => {
    let registry: TestRegistry;
    let owner: Person;
    let member: Person;
    let ana: Person;
    let bo: Person;
    let cy: Person;
    let dee: Person;
    let orgId: string;

    const page = async (who: Person = owner) => {
      const reply = await registry.consoleGet(who, P);
      expect(reply.status, reply.text).toBe(200);
      return GuardProtectionPage.parse(reply.body);
    };
    const preview = (changes: Change[], who: Person = owner) => registry.consoleWrite(who, "POST", `${P}/preview`, { changes });
    const apply = (changes: Change[], revision: number, who: Person = owner) => registry.consoleWrite(who, "POST", `${P}/apply`, { changes, revision });
    const previewed = async (changes: Change[]) => {
      const reply = await preview(changes);
      expect(reply.status, reply.text).toBe(200);
      return GuardProtectionPreview.parse(reply.body);
    };
    const applied = async (changes: Change[]) => {
      const reply = await apply(changes, (await page()).revision);
      expect(reply.status, reply.text).toBe(200);
      return GuardProtectionApplied.parse(reply.body);
    };
    const standings = async () => Object.fromEntries((await page()).people.map((p) => [p.userId, `${p.mode} (${p.source})`]));
    const standingOf = async (who: Person) => required((await page()).people.find((p) => p.userId === who.userId), `${who.email} on the protection page`);
    const protectionLines = async () =>
      (await required(registry.server.service.vault, "the vault").listAudit(orgId, 5000)).reverse().filter((row) => row.detail?.startsWith("guard.protection.changed:")).map((row) => ({ actor: row.actor, actorKind: row.actorKind, detail: row.detail ?? "" }));
    const rollout = (revision: number | string) => registry.consoleGet(owner, `${P}/rollout?revision=${revision}`);
    const rolloutOf = async (revision: number) => {
      const reply = await rollout(revision);
      expect(reply.status, reply.text).toBe(200);
      return GuardProtectionRollout.parse(reply.body);
    };
    const refusal = (reply: ConsoleReply) => reply.body as { code: string; message: string; detail?: string };

    const preflight = async (laptop: EnrolledDevice, device: GuardDeviceFacts) => {
      const reply = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody(device.hostname, { device }));
      expect(reply.status, reply.text).toBe(200);
      return GuardPreflightResponse.parse(reply.body);
    };
    const download = async (laptop: EnrolledDevice): Promise<SignedGuardBundle> => {
      const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect(reply.status, reply.text).toBe(200);
      return required(GuardRuleDownloadResponse.parse(reply.body).bundle, "a bundle");
    };
    const syncs = async (laptop: EnrolledDevice, device: GuardDeviceFacts) => {
      await preflight(laptop, device);
      const signed = await download(laptop);
      const post = await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, {
        protocol: GUARD_PROTOCOL_VERSION,
        bundleVersion: signed.bundle.bundleVersion,
        catalogueVersion: signed.bundle.catalogueVersion,
        rulesReceived: signed.bundle.contentRules.length,
        rulesProcessed: signed.bundle.contentRules.length,
        clientMode: signed.bundle.clientMode,
        bundleDigest: digestOf(signed.bundle),
      });
      expect(post.status, post.text).toBe(200);
      return signed.bundle;
    };

    beforeAll(async () => {
      registry = await startRegistry({ domain: `guard-protection-${twin.postgres ? "pg" : "file"}.example`, ...(twin.postgres ? {} : { storage: "file" as const }) });
      ({ owner, member, admin: cy } = registry.people);
      dee = member;
      ana = await registry.join("ana");
      bo = await registry.join("bo");
      orgId = ((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId;
    });

    afterAll(async () => {
      await registry?.close();
    });

    afterEach(async () => {
      const now = await page();
      const set = now.people.filter((p) => p.source === "set").map((p) => p.userId);
      const reply = await apply([...(set.length === 0 ? [] : [{ userIds: set, clear: true as const }]), { default: "monitor" }], now.revision);
      expect(reply.status, reply.text).toBe(200);
    });

    it("reads the org default and each member's mode with where it comes from", async () => {
      const before = await page();
      expect(before.defaultMode).toBe("monitor");
      expect(before.people.map((p) => p.email).sort()).toEqual([owner, cy, dee, ana, bo].map((p) => p.email).sort());
      expect(before.people.every((p) => p.mode === "monitor" && p.source === "default" && p.setBy === undefined)).toBe(true);

      const { revision } = await applied([{ userIds: [ana.userId], mode: "off" }]);
      const after = await page();
      expect(after.revision).toBe(revision);
      expect(after.people.find((p) => p.userId === ana.userId)).toMatchObject({ email: ana.email, name: "ana", mode: "off", source: "set", setBy: owner.email });
      expect(after.people.find((p) => p.userId === bo.userId)).toMatchObject({ mode: "monitor", source: "default" });
    });

    it("previews exactly the people the apply then changes, writes nothing on preview, and moves each to the previewed mode", async () => {
      await applied([{ userIds: [cy.userId], mode: "enforce" }, { userIds: [dee.userId], mode: "off" }]);
      const before = await page();
      const changes: Change[] = [{ userIds: [ana.userId, cy.userId], mode: "enforce" }, { userIds: [dee.userId], clear: true }, { default: "off" }];
      const shown = await previewed(changes);
      expect(shown.revision).toBe(before.revision);
      expect(await page()).toEqual(before);

      const others = before.people.filter((p) => p.source === "default" && p.userId !== ana.userId).map((p) => p.userId);
      expect(shown.people.map((p) => p.userId).sort()).toEqual([ana.userId, cy.userId, dee.userId, ...others].sort());
      expect(shown.people.find((p) => p.userId === cy.userId)).toMatchObject({ from: "enforce", to: "enforce", effect: "Nothing changes" });
      expect(shown.people.find((p) => p.userId === dee.userId)).toMatchObject({ from: "off", to: "off" });
      expect(shown.summary).toContain("The organisation default changes from Monitor to Off.");
      expect(shown.summary).toContain("1 person is already as asked.");

      const done = GuardProtectionApplied.parse((await apply(changes, shown.revision)).body);
      expect(done).toEqual({ revision: shown.revision + 1, applied: shown.people.length - 1, unchanged: 1 });
      const after = await page();
      expect(after.defaultMode).toBe("off");
      for (const row of shown.people) expect(after.people.find((p) => p.userId === row.userId)?.mode, row.email).toBe(row.to);
      expect(after.people.find((p) => p.userId === dee.userId)).toMatchObject({ mode: "off", source: "default" });
    });

    it("refuses an apply on a stale revision and writes nothing", async () => {
      const shown = await previewed([{ userIds: [ana.userId], mode: "enforce" }]);
      await applied([{ userIds: [bo.userId], mode: "off" }]);
      const between = await page();
      const stale = await apply([{ userIds: [ana.userId], mode: "enforce" }], shown.revision);
      expect(stale.status, stale.text).toBe(409);
      expect(refusal(stale).code).toBe("STALE_BASE");
      expect(await page()).toEqual(between);
    });

    it("answers a retry of an apply that already happened with 200 and nothing changed", async () => {
      const { revision } = await page();
      const changes: Change[] = [{ userIds: [ana.userId, bo.userId], mode: "enforce" }, { default: "enforce" }];
      const first = await apply(changes, revision);
      expect(GuardProtectionApplied.parse(first.body)).toMatchObject({ revision: revision + 1, unchanged: 0 });
      const lines = (await protectionLines()).length;
      const after = await page();
      const retry = await apply(changes, revision);
      expect(retry.status, retry.text).toBe(200);
      expect(GuardProtectionApplied.parse(retry.body)).toEqual({ revision: revision + 1, applied: 0, unchanged: 2 });
      expect(await page()).toEqual(after);
      expect((await protectionLines()).length).toBe(lines);
    });

    it("lets exactly one of two applies from the same preview through, and a racing copy of it is a retry", async () => {
      const { revision } = await page();
      const [one, two] = await Promise.all([apply([{ userIds: [ana.userId], mode: "enforce" }], revision), apply([{ userIds: [bo.userId], mode: "off" }], revision)]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const winner = one.status === 200 ? { who: ana, mode: "enforce (set)" } : { who: bo, mode: "off (set)" };
      const loser = one.status === 200 ? bo : ana;
      const now = await standings();
      expect(now[winner.who.userId]).toBe(winner.mode);
      expect(now[loser.userId]).toBe("monitor (default)");
      expect((await page()).revision).toBe(revision + 1);

      const same: Change[] = [{ userIds: [cy.userId], mode: "off" }];
      const [a, b] = await Promise.all([apply(same, revision + 1), apply(same, revision + 1)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([GuardProtectionApplied.parse(a.body), GuardProtectionApplied.parse(b.body)].map((r) => `${r.applied}/${r.unchanged}`).sort()).toEqual(["0/1", "1/0"]);
      expect((await page()).revision).toBe(revision + 2);
    });

    it("refuses a preview or apply naming someone outside the org with 422 and writes nothing", async () => {
      const before = await page();
      const changes: Change[] = [{ userIds: [ana.userId, "usr_not_a_member_here"], mode: "enforce" }];
      for (const reply of [await preview(changes), await apply(changes, before.revision)]) {
        expect(reply.status, reply.text).toBe(422);
        expect(refusal(reply)).toMatchObject({ code: "NOT_A_MEMBER", detail: expect.stringContaining("usr_not_a_member_here") });
      }
      expect(await page()).toEqual(before);
    });

    it("refuses more than 1000 people, a person named twice and two default changes, and writes nothing", async () => {
      const before = await page();
      const made = (n: number) => Array.from({ length: n }, (_, i) => `usr_made_up_${i}`);
      const tooMany = await apply([{ userIds: made(600), mode: "enforce" }, { userIds: made(1001).slice(600), clear: true }], before.revision);
      expect(tooMany.status, tooMany.text).toBe(400);
      expect(refusal(tooMany).detail).toContain("at most 1000 people");
      const atTheCap = await apply([{ userIds: made(1000), mode: "enforce" }], before.revision);
      expect(atTheCap.status, atTheCap.text).toBe(422);
      const twice = await preview([{ userIds: [ana.userId], mode: "enforce" }, { userIds: [ana.userId], clear: true }]);
      expect(twice.status, twice.text).toBe(400);
      expect(refusal(twice).detail).toContain(`${ana.userId} is named more than once`);
      const defaults = await apply([{ default: "off" }, { default: "enforce" }], before.revision);
      expect(defaults.status, defaults.text).toBe(400);
      expect(await page()).toEqual(before);
    });

    it("writes one audit line per person whose protection changed, with who changed it, from what and to what", async () => {
      await applied([{ userIds: [cy.userId], mode: "off" }, { userIds: [dee.userId], mode: "enforce" }]);
      const before = (await protectionLines()).length;
      const { revision } = await applied([{ userIds: [ana.userId, dee.userId], mode: "enforce" }, { userIds: [cy.userId], clear: true }]);
      const lines = (await protectionLines()).slice(before);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.actor === owner.email && line.actorKind === "admin")).toBe(true);
      expect(lines.map((line) => line.detail).sort()).toEqual(
        [`guard.protection.changed: ${ana.email} (${ana.userId}) monitor (default) -> enforce (set) at revision ${revision}`, `guard.protection.changed: ${cy.email} (${cy.userId}) off (set) -> monitor (default) at revision ${revision}`].sort(),
      );
    });

    it("clears a person back to the default by deleting their own setting, and still raises their policy's stamp", async () => {
      const device = facts("ana-mbp", CAN_TURN_OFF);
      const laptop = await enrolDevice(registry, owner, ana, "ana-mbp", device);
      await applied([{ userIds: [ana.userId], mode: "off" }]);
      const set = await syncs(laptop, device);
      expect(set.clientMode).toBe("off");
      expect(required(await registry.server.service.guard?.getPersonProtection(orgId, ana.userId), "Ana's row").mode).toBe("off");

      const shown = await previewed([{ userIds: [ana.userId], clear: true }]);
      expect(shown.people).toEqual([{ userId: ana.userId, email: ana.email, name: "ana", from: "off", to: "monitor", effect: "Guard starts inspecting their AI traffic and records what it would block, without blocking" }]);
      await applied([{ userIds: [ana.userId], clear: true }]);
      expect(await standingOf(ana)).toEqual({ userId: ana.userId, email: ana.email, name: "ana", mode: "monitor", source: "default" });
      expect(await registry.server.service.guard?.getPersonProtection(orgId, ana.userId)).toBeUndefined();
      const cleared = await syncs(laptop, device);
      expect(cleared.clientMode).toBe("monitor");
      expect(cleared.protectionRevision).toBeGreaterThan(set.protectionRevision);
    });

    it("moves only the people on the default when the default changes, and stores it as the org's Guard setting", async () => {
      await applied([{ userIds: [ana.userId], mode: "monitor" }, { userIds: [bo.userId], mode: "off" }]);
      const shown = await previewed([{ default: "enforce" }]);
      const onDefault = (await page()).people.filter((p) => p.source === "default").map((p) => p.userId);
      expect(shown.people.map((p) => p.userId).sort()).toEqual(onDefault.sort());
      expect(shown.people.every((p) => p.from === "monitor" && p.to === "enforce" && p.effect === "Matches will now be blocked")).toBe(true);
      await applied([{ default: "enforce" }]);
      const now = await standings();
      expect(now[ana.userId]).toBe("monitor (set)");
      expect(now[bo.userId]).toBe("off (set)");
      for (const userId of onDefault) expect(now[userId]).toBe("enforce (default)");
      expect(GuardSettingsPage.parse((await registry.consoleGet(owner, "/guard/settings")).body).settings.clientMode).toBe("enforce");
    });

    it("changes the default through the settings door the same way: one revision, one line per person it moves", async () => {
      await applied([{ userIds: [ana.userId], mode: "enforce" }]);
      const before = await page();
      const lines = (await protectionLines()).length;
      const put = await registry.consoleWrite(owner, "PUT", "/guard/settings", { clientMode: "off" });
      expect(put.status, put.text).toBe(200);
      const after = await page();
      expect(after).toMatchObject({ defaultMode: "off", revision: before.revision + 1 });
      const moved = before.people.filter((p) => p.source === "default");
      const added = (await protectionLines()).slice(lines).map((line) => line.detail);
      expect(added).toContain(`guard.protection.changed: organisation default monitor -> off at revision ${after.revision}`);
      for (const p of moved) expect(added).toContain(`guard.protection.changed: ${p.email} (${p.userId}) monitor (default) -> off (default) at revision ${after.revision}`);
      expect(added).toHaveLength(moved.length + 1);
      expect(await standingOf(ana)).toMatchObject({ mode: "enforce", source: "set" });
    });

    it("says what each change of mode does to the person, not which setting moves", async () => {
      await applied([{ userIds: [ana.userId], mode: "off" }, { userIds: [bo.userId], mode: "monitor" }, { userIds: [cy.userId], mode: "enforce" }]);
      const cases: Array<[Change, Person, GuardClientMode, GuardClientMode, string]> = [
        [{ userIds: [ana.userId], mode: "monitor" }, ana, "off", "monitor", "Guard starts inspecting their AI traffic and records what it would block, without blocking"],
        [{ userIds: [ana.userId], mode: "enforce" }, ana, "off", "enforce", "Guard starts inspecting their AI traffic; matches will now be blocked"],
        [{ userIds: [bo.userId], mode: "off" }, bo, "monitor", "off", "Guard stops checking their AI traffic; nothing is recorded"],
        [{ userIds: [bo.userId], mode: "enforce" }, bo, "monitor", "enforce", "Matches will now be blocked"],
        [{ userIds: [cy.userId], mode: "off" }, cy, "enforce", "off", "Guard stops checking their AI traffic; nothing is recorded or blocked"],
        [{ userIds: [cy.userId], mode: "monitor" }, cy, "enforce", "monitor", "Matches will be recorded, no longer blocked"],
        [{ userIds: [cy.userId], mode: "enforce" }, cy, "enforce", "enforce", "Nothing changes"],
        [{ userIds: [dee.userId], mode: "monitor" }, dee, "monitor", "monitor", "Stays Monitor; a change to the organisation default no longer moves them"],
        [{ userIds: [bo.userId], clear: true }, bo, "monitor", "monitor", "Stays Monitor, and follows the organisation default from now on"],
      ];
      for (const [change, who, from, to, effect] of cases) {
        expect((await previewed([change])).people, JSON.stringify(change)).toEqual([{ userId: who.userId, email: who.email, name: who.name, from, to, effect }]);
      }
      expect((await previewed([{ userIds: [ana.userId, bo.userId], mode: "enforce" }, { userIds: [cy.userId], mode: "enforce" }])).summary).toBe(
        "Changes 2 people: 1 from Off to Enforce, 1 from Monitor to Enforce. 1 person is already as asked.",
      );
      expect((await previewed([{ userIds: [cy.userId], mode: "enforce" }])).summary).toBe("1 person is already as asked.");
    });

    it("follows a change to each person's Macs: applied once a Mac reports the mode and holds the new policy, pending until then", async () => {
      const boFacts = facts("bo-mbp", CAN_TURN_OFF);
      const boMini = facts("bo-mini", CAN_TURN_OFF);
      const boLaptop = await enrolDevice(registry, owner, bo, "bo-mbp", boFacts);
      const boDesk = await enrolDevice(registry, owner, bo, "bo-mini", boMini);
      const cyOld = facts("cy-old-mbp");
      const cyLaptop = await enrolDevice(registry, owner, cy, "cy-old-mbp", cyOld);

      const { revision } = await applied([{ userIds: [bo.userId], mode: "enforce" }]);
      const waiting = await rolloutOf(revision);
      expect(waiting).toMatchObject({ revision, applied: 0, pending: 2 });
      expect(waiting.people.map((p) => p.userId)).toEqual([bo.userId]);
      expect(required(waiting.people[0], "Bo").devices.map((d) => `${d.hostname} ${d.state} ${d.clientMode}`).sort()).toEqual(["bo-mbp pending monitor", "bo-mini pending monitor"]);

      await syncs(boLaptop, boFacts);
      const half = await rolloutOf(revision);
      expect(half).toMatchObject({ applied: 1, pending: 1 });
      const macs = required(half.people[0], "Bo").devices;
      expect(macs.find((d) => d.deviceId === boLaptop.deviceId)).toMatchObject({ state: "applied", clientMode: "enforce", lastSeenAt: expect.any(String) });
      expect(macs.find((d) => d.deviceId === boDesk.deviceId)).toMatchObject({ state: "pending", clientMode: "monitor" });

      const off = await applied([{ userIds: [cy.userId], mode: "off" }]);
      expect((await syncs(cyLaptop, cyOld)).clientMode).toBe("monitor");
      const legacy = await rolloutOf(off.revision);
      expect(legacy.people.map((p) => `${p.email} ${p.mode} ${p.devices.map((d) => d.state).join(",")}`)).toEqual([`${cy.email} off pending`]);
      expect((await rolloutOf(revision)).people.map((p) => p.userId)).toEqual([bo.userId]);

      for (const wrong of ["", "abc", "0", String(off.revision + 1)]) expect((await rollout(wrong)).status, wrong).toBe(400);
    });

    it("refuses a member on every protection door and writes nothing, and refuses a write without its CSRF token", async () => {
      const before = await page();
      for (const reply of [
        await registry.consoleGet(member, P),
        await preview([{ userIds: [member.userId], mode: "off" }], member),
        await apply([{ userIds: [member.userId], mode: "off" }], before.revision, member),
        await registry.consoleGet(member, `${P}/rollout?revision=1`),
      ]) {
        expect(reply.status, reply.text).toBe(403);
        expect(refusal(reply).code).toBe("admin_only");
      }
      const noCsrf = await fetch(`${registry.url}${CONSOLE_API_PREFIX}${P}/apply`, {
        method: "POST",
        headers: { cookie: owner.cookie, origin: REGISTRY_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ changes: [{ userIds: [ana.userId], mode: "off" }], revision: before.revision }),
      });
      expect(noCsrf.status).toBeGreaterThanOrEqual(400);
      expect(await page()).toEqual(before);
    });
  });
}
