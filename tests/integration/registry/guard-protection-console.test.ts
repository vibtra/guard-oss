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
import type { GuardStore } from "@vibtra/registry/src/guard/store.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { REGISTRY_ORIGIN, startRegistry, type ConsoleReply, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, facts, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";
import { capturingStorage, postgresMissing, type Storage } from "./server-options.ts";

const P = "/people/protection";
const NO_PREVIEW = "0".repeat(64);
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
    const apply = async (changes: Change[], revision: number, who: Person = owner) => {
      const shown = await preview(changes);
      const peopleDigest = shown.status === 200 ? GuardProtectionPreview.parse(shown.body).peopleDigest : NO_PREVIEW;
      return registry.consoleWrite(who, "POST", `${P}/apply`, { changes, revision, peopleDigest });
    };
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

    it("refuses an apply previewed under another Uninspectable TLS setting, for people and for the default, and writes nothing", async () => {
      const setTls = async (unreproducibleTls: "block" | "tunnel") => {
        const reply = await registry.consoleWrite(owner, "PUT", "/guard/settings", { unreproducibleTls });
        expect(reply.status, reply.text).toBe(200);
      };
      const applyAsShown = (changes: Change[], shown: GuardProtectionPreview) => registry.consoleWrite(owner, "POST", `${P}/apply`, { changes, revision: shown.revision, peopleDigest: shown.peopleDigest });
      try {
        const cases: Array<{ changes: Change[]; from: "block" | "tunnel"; to: "block" | "tunnel" }> = [
          { changes: [{ userIds: [ana.userId], mode: "monitor" }], from: "block", to: "tunnel" },
          { changes: [{ default: "off" }], from: "tunnel", to: "block" },
        ];
        for (const { changes, from, to } of cases) {
          await setTls(from);
          const shown = await previewed(changes);
          await setTls(to);
          const before = await page();
          const late = await applyAsShown(changes, shown);
          expect(late.status, late.text).toBe(409);
          expect(refusal(late).code).toBe("STALE_BASE");
          expect(await page()).toEqual(before);

          const again = await previewed(changes);
          expect(again.peopleDigest).not.toBe(shown.peopleDigest);
          const done = await applyAsShown(changes, again);
          expect(done.status, done.text).toBe(200);
        }
      } finally {
        await setTls("block");
      }
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

    it("counts the 1000-person cap in people, not in changes, so 1000 people named one per change can come with a default change", async () => {
      const before = await page();
      const onePerChange = (n: number): Change[] => Array.from({ length: n }, (_, i) => ({ userIds: [`usr_made_up_${i}`], mode: "enforce" }));
      const atTheCap = await apply([...onePerChange(1000), { default: "off" }], before.revision);
      expect(atTheCap.status, atTheCap.text).toBe(422);
      expect(refusal(atTheCap).code).toBe("NOT_A_MEMBER");
      const overTheCap = await apply(onePerChange(1001), before.revision);
      expect(overTheCap.status, overTheCap.text).toBe(400);
      expect(refusal(overTheCap).detail).toContain("at most 1000 people");
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
      expect((await rolloutOf(revision)).people.map((p) => p.userId).sort()).toEqual([bo.userId, cy.userId].sort());

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

    it("answers a retry with the revision its change was made at, not a later one", async () => {
      const { revision } = await page();
      const changes: Change[] = [{ userIds: [ana.userId, bo.userId], mode: "enforce" }];
      const first = await apply(changes, revision);
      expect(GuardProtectionApplied.parse(first.body)).toEqual({ revision: revision + 1, applied: 2, unchanged: 0 });
      await applied([{ userIds: [dee.userId], mode: "off" }]);
      const retry = await apply(changes, revision);
      expect(retry.status, retry.text).toBe(200);
      expect(GuardProtectionApplied.parse(retry.body)).toEqual({ revision: revision + 1, applied: 0, unchanged: 2 });

      const before = await page();
      const onDefault: Change[] = [{ default: "enforce" }];
      expect(GuardProtectionApplied.parse((await apply(onDefault, before.revision)).body)).toMatchObject({ revision: before.revision + 1 });
      await applied([{ userIds: [dee.userId], mode: "enforce" }]);
      const again = await apply(onDefault, before.revision);
      expect(again.status, again.text).toBe(200);
      expect(GuardProtectionApplied.parse(again.body)).toEqual({ revision: before.revision + 1, applied: 0, unchanged: 0 });
    });

    it("saves a new org default even when everyone is set and it moves nobody", async () => {
      await applied([{ userIds: (await page()).people.map((p) => p.userId), mode: "monitor" }]);
      const { revision } = await page();
      const reply = await apply([{ default: "enforce" }], revision);
      expect(reply.status, reply.text).toBe(200);
      expect(GuardProtectionApplied.parse(reply.body)).toEqual({ revision: revision + 1, applied: 0, unchanged: 0 });
      expect(await page()).toMatchObject({ defaultMode: "enforce", revision: revision + 1 });
      expect(new Set(Object.values(await standings()))).toEqual(new Set(["monitor (set)"]));
    });

    it("holds the second of two applies from one preview at the org lock, then refuses it", async () => {
      const { revision } = await page();
      const boBefore = (await standings())[bo.userId];
      const guardStore = required(registry.server.service.guard, "the guard store");
      const save = guardStore.saveSettings;
      let reached = (): void => undefined;
      let release = (): void => undefined;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      guardStore.saveSettings = async (tx, change) => {
        guardStore.saveSettings = save;
        reached();
        await gate;
        return save.call(guardStore, tx, change);
      };
      try {
        const held = apply([{ userIds: [ana.userId], mode: "enforce" }], revision);
        await arrived;
        let waited = true;
        const second = apply([{ userIds: [bo.userId], mode: "off" }], revision).finally(() => (waited = false));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(waited, "the second apply waits for the org lock").toBe(true);
        release();
        const first = await held;
        expect(first.status, first.text).toBe(200);
        const refused = await second;
        expect(refused.status, refused.text).toBe(409);
        expect(refusal(refused).code).toBe("STALE_BASE");
      } finally {
        guardStore.saveSettings = save;
        release();
      }
      expect(await standings()).toMatchObject({ [ana.userId]: "enforce (set)", [bo.userId]: boBefore });
      expect((await page()).revision).toBe(revision + 1);
    });

    const readInTurn = async (writes: Array<() => Promise<ConsoleReply>>): Promise<ConsoleReply[]> => {
      const guardStore = required(registry.server.service.guard, "the guard store");
      const read = guardStore.getOrgProtection;
      let reads = 0;
      let reached = (): void => undefined;
      let release = (): void => undefined;
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      guardStore.getOrgProtection = async (tx) => {
        reads += 1;
        const snapshot = await read.call(guardStore, tx);
        if (reads === 1) {
          reached();
          await gate;
        }
        return snapshot;
      };
      try {
        const [head, ...rest] = writes;
        const replies = [required(head, "a first write")()];
        await arrived;
        replies.push(...rest.map((write) => write()));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(reads, "the other writes wait for the org lock before they read").toBe(1);
        release();
        return await Promise.all(replies);
      } finally {
        guardStore.getOrgProtection = read;
        release();
      }
    };
    const defaultMoveLines = (people: GuardProtectionPage["people"], revision: number) =>
      [
        `guard.protection.changed: organisation default monitor -> enforce at revision ${revision}`,
        ...people.map((p) => `guard.protection.changed: ${p.email} (${p.userId}) monitor (default) -> enforce (default) at revision ${revision}`),
      ].sort();

    it("credits a default change once when two admins send it from the same state at once", async () => {
      const before = await page();
      const changes: Change[] = [{ default: "enforce" }];
      const shown = await previewed(changes);
      const lines = (await protectionLines()).length;
      const replies = await readInTurn([owner, cy].map((who) => () => registry.consoleWrite(who, "POST", `${P}/apply`, { changes, revision: shown.revision, peopleDigest: shown.peopleDigest })));
      for (const reply of replies) expect([200, 409], reply.text).toContain(reply.status);
      const done = replies.filter((reply) => reply.status === 200).map((reply) => GuardProtectionApplied.parse(reply.body));
      expect(done.map((r) => r.applied).sort((a, b) => a - b)).toEqual(done.length === 2 ? [0, before.people.length] : [before.people.length]);
      const added = (await protectionLines()).slice(lines);
      expect(new Set(added.map((line) => line.actor)).size).toBe(1);
      expect(added.map((line) => line.detail).sort()).toEqual(defaultMoveLines(before.people, before.revision + 1));
      expect((await page()).revision).toBe(before.revision + 1);
    });

    it.each([{ first: "the settings save" }, { first: "the apply" }])("credits a default change once when the settings door saves the same default at the same moment, $first going first", async ({ first }) => {
      const before = await page();
      const changes: Change[] = [{ default: "enforce" }];
      const shown = await previewed(changes);
      const lines = (await protectionLines()).length;
      const applyIt = () => registry.consoleWrite(owner, "POST", `${P}/apply`, { changes, revision: shown.revision, peopleDigest: shown.peopleDigest });
      const saveIt = () => registry.consoleWrite(cy, "PUT", "/guard/settings", { clientMode: "enforce" });
      const replies = await readInTurn(first === "the apply" ? [applyIt, saveIt] : [saveIt, applyIt]);
      const [applyReply, saveReply] = first === "the apply" ? replies : [replies[1], replies[0]];
      expect(saveReply?.status, saveReply?.text).toBe(200);
      expect([200, 409], applyReply?.text).toContain(applyReply?.status);
      const added = (await protectionLines()).slice(lines);
      expect(added.map((line) => line.detail).sort()).toEqual(defaultMoveLines(before.people, before.revision + 1));
      const credited = new Set(added.map((line) => line.actor));
      expect(credited.size).toBe(1);
      if (applyReply?.status === 200) expect(GuardProtectionApplied.parse(applyReply.body).applied).toBe(credited.has(owner.email) ? before.people.length : 0);
      expect((await page()).revision).toBe(before.revision + 1);
    });

    it("lists everyone whose policy changed at or after a revision, people on the default too, with only their active Macs", async () => {
      const deeFacts = facts("dee-air", CAN_TURN_OFF);
      const deeAir = await enrolDevice(registry, owner, dee, "dee-air", deeFacts);
      const ownerFacts = facts("owner-mbp", CAN_TURN_OFF);
      const ownerMac = await enrolDevice(registry, owner, owner, "owner-mbp", ownerFacts);
      await syncs(ownerMac, ownerFacts);
      const revoked = await registry.consoleWrite(owner, "POST", `/guard/devices/${ownerMac.deviceId}/revoke`, {});
      expect(revoked.status, revoked.text).toBe(200);

      await applied([{ userIds: [ana.userId], mode: "enforce" }]);
      const cleared = await applied([{ userIds: [ana.userId], clear: true }]);
      expect((await syncs(deeAir, deeFacts)).protectionRevision).toBe(cleared.revision);
      await applied([{ userIds: [cy.userId], mode: "enforce" }]);
      await applied([{ userIds: [cy.userId], clear: true }]);

      const later = await rolloutOf(cleared.revision);
      expect(later.people.map((p) => `${p.userId} ${p.mode}`).sort()).toEqual([owner, cy, dee, ana, bo].map((p) => `${p.userId} monitor`).sort());
      const deeMacs = () => required(later.people.find((p) => p.userId === dee.userId), "Dee").devices;
      expect(deeMacs().find((d) => d.deviceId === deeAir.deviceId)).toMatchObject({ state: "pending", clientMode: "monitor" });
      expect(required(later.people.find((p) => p.userId === owner.userId), "the owner").devices).toEqual([]);

      await syncs(deeAir, deeFacts);
      const synced = required((await rolloutOf(cleared.revision)).people.find((p) => p.userId === dee.userId), "Dee").devices;
      expect(synced.find((d) => d.deviceId === deeAir.deviceId)).toMatchObject({ state: "applied", clientMode: "monitor" });
    });

    it("follows a change with one read of each kind from the guard store, however many Macs it covers", async () => {
      const macs = await Promise.all(
        ["owner-one", "owner-two", "owner-three"].map(async (hostname) => {
          const device = facts(hostname, CAN_TURN_OFF);
          return { device, laptop: await enrolDevice(registry, owner, owner, hostname, device) };
        }),
      );
      const { revision } = await applied([{ userIds: [owner.userId], mode: "enforce" }]);
      for (const mac of macs) await syncs(mac.laptop, mac.device);
      const guardStore = required(registry.server.service.guard, "the guard store") as unknown as Record<string, unknown>;
      const methods = Object.entries(guardStore).filter((entry): entry is [string, (...args: unknown[]) => unknown] => typeof entry[1] === "function");
      const calls = new Map<string, number>();
      for (const [name, method] of methods) {
        guardStore[name] = (...args: unknown[]) => {
          calls.set(name, (calls.get(name) ?? 0) + 1);
          return method.apply(guardStore, args);
        };
      }
      let followed: GuardProtectionRollout;
      try {
        followed = await rolloutOf(revision);
      } finally {
        for (const [name, method] of methods) guardStore[name] = method;
      }
      const ownerMacs = required(followed.people.find((p) => p.userId === owner.userId), "the owner").devices.filter((d) => macs.some((mac) => mac.laptop.deviceId === d.deviceId));
      expect(ownerMacs.map((d) => d.state)).toEqual(["applied", "applied", "applied"]);
      expect([...calls].filter(([, count]) => count > 1)).toEqual([]);
    });

    it("says a Mac on an older Guard keeps inspecting someone set to Off until Guard is updated on it", async () => {
      await enrolDevice(registry, owner, dee, "dee-old-mbp", facts("dee-old-mbp"));
      await enrolDevice(registry, owner, cy, "cy-older-mbp", facts("cy-older-mbp"));
      const gone = await enrolDevice(registry, owner, ana, "ana-older-mbp", facts("ana-older-mbp"));
      expect((await registry.consoleWrite(owner, "POST", `/guard/devices/${gone.deviceId}/revoke`, {})).status).toBe(200);
      await applied([{ userIds: [dee.userId], mode: "enforce" }]);
      const shown = await previewed([{ userIds: [dee.userId, cy.userId, ana.userId], mode: "off" }]);
      const effectOf = (who: Person) => required(shown.people.find((p) => p.userId === who.userId), who.email).effect;
      expect(effectOf(dee)).toBe("Nothing is recorded or blocked; their Mac keeps inspecting until Guard is updated on it");
      expect(effectOf(cy)).toBe("Nothing is recorded; their Mac keeps inspecting until Guard is updated on it");
      expect(effectOf(ana)).toBe("Guard stops checking their AI traffic; nothing is recorded");
      expect((await previewed([{ userIds: [dee.userId], mode: "monitor" }])).people).toMatchObject([{ userId: dee.userId, effect: "Matches will be recorded, no longer blocked" }]);
    });
  });
}

describe.skipIf(postgresMissing())("protection changes and settings saves that race on two connections, in Postgres", () => {
  let registry: TestRegistry;
  let storage: Storage | undefined;
  let side: ReturnType<typeof createPostgresRegistryStores> | undefined;
  let owner: Person;
  let member: Person;
  let ana: Person;
  let orgId: string;

  const sidePool = () => required(side, "a second connection pool").pool;
  const page = async () => GuardProtectionPage.parse((await registry.consoleGet(owner, P)).body);
  const settings = async () => GuardSettingsPage.parse((await registry.consoleGet(owner, "/guard/settings")).body).settings;
  const apply = async (changes: Change[], revision: number) => {
    const shown = await registry.consoleWrite(owner, "POST", `${P}/preview`, { changes });
    const peopleDigest = shown.status === 200 ? GuardProtectionPreview.parse(shown.body).peopleDigest : NO_PREVIEW;
    return registry.consoleWrite(owner, "POST", `${P}/apply`, { changes, revision, peopleDigest });
  };
  const save = (body: Record<string, unknown>) => registry.consoleWrite(owner, "PUT", "/guard/settings", body);
  const protectionLines = async () =>
    (await required(registry.server.service.vault, "the vault").listAudit(orgId, 5000)).map((row) => row.detail ?? "").filter((detail) => detail.startsWith("guard.protection.changed:"));

  const blockedBehind = async (pid: number): Promise<number> => {
    for (let tries = 0; tries < 400; tries += 1) {
      const { rows } = await sidePool().query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
      if (rows[0] !== undefined) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no query waited behind backend ${pid}`);
  };

  const inTurn = async (first: () => Promise<ConsoleReply>, second: () => Promise<ConsoleReply>): Promise<[ConsoleReply, ConsoleReply]> => {
    await sidePool().query("INSERT INTO guard_protection_revision (org_id, revision, default_revision) VALUES ($1, 0, 0) ON CONFLICT (org_id) DO NOTHING", [orgId]);
    const client = await sidePool().connect();
    const started: Array<Promise<ConsoleReply>> = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT revision FROM guard_protection_revision WHERE org_id = $1 FOR UPDATE", [orgId]);
      const holder = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
      started.push(first());
      const waiting = await blockedBehind(holder);
      started.push(second());
      await blockedBehind(waiting);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled(started);
      throw e;
    } finally {
      client.release();
    }
    const [one, two] = await Promise.all(started);
    return [required(one, "the first reply"), required(two, "the second reply")];
  };

  beforeAll(async () => {
    registry = await startRegistry({ domain: "guard-protection-races.example", configure: capturingStorage((captured) => (storage = captured)) });
    side = createPostgresRegistryStores(required(required(storage, "the captured storage").databaseUrl, "a database URL"));
    ({ owner, member } = registry.people);
    ana = await registry.join("ana");
    orgId = ((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId;
  });

  afterAll(async () => {
    await side?.close();
    await registry?.close();
  });

  afterEach(async () => {
    const now = await page();
    const set = now.people.filter((p) => p.source === "set").map((p) => p.userId);
    const reply = await apply([...(set.length === 0 ? [] : [{ userIds: set, clear: true as const }]), { default: "monitor" }], now.revision);
    expect(reply.status, reply.text).toBe(200);
  });

  it("keeps a settings save that lands while an apply waits, because the apply changes only the org default", async () => {
    const before = await settings();
    const { revision } = await page();
    const [saved, done] = await inTurn(
      () => save({ quietAfterMinutes: before.quietAfterMinutes + 30 }),
      () => apply([{ default: "enforce" }, { userIds: [ana.userId], mode: "off" }], revision),
    );
    expect(saved.status, saved.text).toBe(200);
    expect(done.status, done.text).toBe(200);
    expect(await settings()).toMatchObject({ clientMode: "enforce", quietAfterMinutes: before.quietAfterMinutes + 30 });
    expect((await page()).people.find((p) => p.userId === ana.userId)).toMatchObject({ mode: "off", source: "set" });
  });

  it("refuses an apply when the Uninspectable TLS setting is saved while the apply waits, and writes nothing", async () => {
    const before = await settings();
    const other = before.unreproducibleTls === "block" ? "tunnel" : "block";
    const { revision } = await page();
    try {
      const [saved, late] = await inTurn(
        () => save({ unreproducibleTls: other }),
        () => apply([{ userIds: [ana.userId], mode: "monitor" }], revision),
      );
      expect(saved.status, saved.text).toBe(200);
      expect(late.status, late.text).toBe(409);
      expect((late.body as { code: string }).code).toBe("STALE_BASE");
      expect((await page()).people.find((p) => p.userId === ana.userId)).toMatchObject({ mode: "monitor", source: "default" });
      expect(await settings()).toMatchObject({ unreproducibleTls: other });
    } finally {
      expect((await save({ unreproducibleTls: before.unreproducibleTls })).status).toBe(200);
    }
  });

  it("keeps an apply's org default when a settings save of another setting waits behind it", async () => {
    const before = await settings();
    const { revision } = await page();
    const [done, saved] = await inTurn(
      () => apply([{ default: "off" }], revision),
      () => save({ quietAfterMinutes: before.quietAfterMinutes + 30 }),
    );
    expect(done.status, done.text).toBe(200);
    expect(saved.status, saved.text).toBe(200);
    expect(await settings()).toMatchObject({ clientMode: "off", quietAfterMinutes: before.quietAfterMinutes + 30 });
  });

  it("writes the settings door's per-person lines from the state it saved on, when an apply lands first", async () => {
    const before = await page();
    const [done, saved] = await inTurn(
      () => apply([{ userIds: [member.userId], mode: "enforce" }], before.revision),
      () => save({ clientMode: "off" }),
    );
    expect(done.status, done.text).toBe(200);
    expect(saved.status, saved.text).toBe(200);
    const after = await page();
    expect(after).toMatchObject({ defaultMode: "off", revision: before.revision + 2 });
    expect(after.people.find((p) => p.userId === member.userId)).toMatchObject({ mode: "enforce", source: "set" });
    const atSave = (await protectionLines()).filter((line) => line.endsWith(` at revision ${after.revision}`));
    const moved = before.people.filter((p) => p.source === "default" && p.userId !== member.userId);
    expect(atSave.sort()).toEqual(
      [
        `guard.protection.changed: organisation default monitor -> off at revision ${after.revision}`,
        ...moved.map((p) => `guard.protection.changed: ${p.email} (${p.userId}) monitor (default) -> off (default) at revision ${after.revision}`),
      ].sort(),
    );
  });
});

describe("people who join or leave the organisation", () => {
  let registry: TestRegistry;
  let owner: Person;

  const page = async () => GuardProtectionPage.parse((await registry.consoleGet(owner, P)).body);
  const previewed = async (changes: Change[]) => {
    const reply = await registry.consoleWrite(owner, "POST", `${P}/preview`, { changes });
    expect(reply.status, reply.text).toBe(200);
    return GuardProtectionPreview.parse(reply.body);
  };
  const applyAsShown = (changes: Change[], shown: GuardProtectionPreview) => registry.consoleWrite(owner, "POST", `${P}/apply`, { changes, revision: shown.revision, peopleDigest: shown.peopleDigest });

  beforeAll(async () => {
    registry = await startRegistry({ domain: "guard-protection-joiners.example" });
    ({ owner } = registry.people);
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("refuses an apply that would move someone its preview did not show, and writes nothing", async () => {
    const changes: Change[] = [{ default: "off" }];
    const shown = await previewed(changes);
    const joiner = await registry.join("latecomer");
    const before = await page();
    const late = await applyAsShown(changes, shown);
    expect(late.status, late.text).toBe(409);
    expect((late.body as { code: string }).code).toBe("STALE_BASE");
    expect(await page()).toEqual(before);

    const again = await previewed(changes);
    expect(again.people.map((p) => p.userId)).toContain(joiner.userId);
    const done = await applyAsShown(changes, again);
    expect(done.status, done.text).toBe(200);
    expect(GuardProtectionApplied.parse(done.body)).toMatchObject({ applied: again.people.length });
  });

  const setOffOnMonitor = async (who: Person) => {
    const changes: Change[] = [{ default: "monitor" }, { userIds: [who.userId], mode: "off" }];
    const set = await applyAsShown(changes, await previewed(changes));
    expect(set.status, set.text).toBe(200);
    expect((await page()).people.find((p) => p.userId === who.userId)).toMatchObject({ mode: "off", source: "set" });
  };

  it("forgets the mode set for someone who is removed, so they come back on the org default", async () => {
    const leaver = await registry.join("leaver");
    await setOffOnMonitor(leaver);
    const removed = await registry.consoleWrite(owner, "DELETE", `/people/${leaver.userId}`);
    expect(removed.status, removed.text).toBe(200);

    const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email: leaver.email, role: "member" });
    expect(invited.status, invited.text).toBe(200);
    const signedIn = await fetch(`${registry.url}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
      body: JSON.stringify({ email: leaver.email, password: `vibtra-test-passphrase-${leaver.email}` }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie().map((line) => line.split(";")[0] ?? "").join("; ");
    const invitationId = String((invited.body as { invitationId: string }).invitationId);
    const accepted = await fetch(`${registry.url}/api/console/invitations/${encodeURIComponent(invitationId)}/accept`, { method: "POST", headers: { origin: REGISTRY_ORIGIN, cookie } });
    expect(accepted.status, await accepted.text()).toBe(200);

    expect((await page()).people.find((p) => p.userId === leaver.userId)).toMatchObject({ mode: "monitor", source: "default" });
  });

  it("forgets the mode set for someone who closes their account", async () => {
    const leaver = registry.people.member;
    await setOffOnMonitor(leaver);
    const orgId = ((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId;
    const closed = await registry.consoleWrite(leaver, "POST", "/account/close");
    expect(closed.status, closed.text).toBe(200);
    expect(await required(registry.server.service.guard, "the guard store").getPersonProtection(orgId, leaver.userId)).toBeUndefined();
  });
});
