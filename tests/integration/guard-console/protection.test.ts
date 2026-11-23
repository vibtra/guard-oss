import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsoleGroupRow } from "@vibtra/console-api";
import type { GuardClientMode, GuardProtectionChange, GuardProtectionPage, GuardProtectionPreview, GuardProtectionRollout } from "@vibtra/guard-contract";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Mode = GuardClientMode;
type Who = { userId: string; email: string; name?: string };
type Ask = { kind: "people"; people: Who[]; to: Mode | "default" } | { kind: "default"; to: Mode; pause?: boolean };
type Model = {
  changesOf: (ask: Ask) => GuardProtectionChange[];
  countsByMode: (people: { mode: Mode }[]) => Record<Mode, number>;
  membersOf: (group: ConsoleGroupRow, people: GuardProtectionPage["people"]) => { people: GuardProtectionPage["people"]; notJoined: number };
  askWords: (ask: Ask, defaultMode: Mode | undefined) => { title: string; confirm: string; danger: boolean };
  effectGroups: (people: GuardProtectionPreview["people"]) => { effect: string; from: Mode; to: Mode; people: { email: string }[] }[];
  movingTo: (people: GuardProtectionPreview["people"], mode: Mode) => number;
  nothingToApply: (ask: Ask, page: GuardProtectionPage) => boolean;
  keptBy: (ask: Ask, page: GuardProtectionPage) => { mode: Mode; count: number; words: string }[];
  protectionHref: (filter?: { mode?: Mode; source?: "set" | "default"; rollout?: number }) => string;
  rolloutView: (
    rollout: GuardProtectionRollout,
    now?: number,
  ) => { lines: { mode: Mode; words: string }[]; pending: { device: { hostname: string } }[]; pendingWords: string | undefined; withoutMacWords: string | undefined; done: boolean };
};

let model: ConsoleModule<Model>;

beforeAll(async () => {
  model = await loadConsoleModule<Model>("/src/protection/model.ts");
});

afterAll(async () => {
  await model?.close();
});

const NOW = Date.parse("2026-11-23T12:00:00Z");
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const person = (n: number, mode: Mode, source: "set" | "default", name?: string): GuardProtectionPage["people"][number] => ({
  userId: `usr_${n}`,
  email: `p${n}@fernwood.example`,
  ...(name === undefined ? {} : { name }),
  mode,
  source,
  ...(source === "set" ? { setBy: "ada@fernwood.example", setAt: ago(60) } : {}),
});

const page = (defaultMode: Mode, people: GuardProtectionPage["people"]): GuardProtectionPage => ({ defaultMode, revision: 7, people });

const moved = (n: number, from: Mode, to: Mode, effect: string, name?: string): GuardProtectionPreview["people"][number] => ({
  userId: `usr_${n}`,
  email: `p${n}@fernwood.example`,
  ...(name === undefined ? {} : { name }),
  from,
  to,
  effect,
});

const mac = (n: number, state: "applied" | "pending", lastSeenMinutes?: number) => ({
  deviceId: `gdev_${String(n).padStart(16, "0")}`,
  hostname: `mac-${n}`,
  state,
  clientMode: state === "applied" ? ("enforce" as const) : ("monitor" as const),
  ...(lastSeenMinutes === undefined ? {} : { lastSeenAt: ago(lastSeenMinutes) }),
});

describe("what the console sends for each kind of change", () => {
  it("sends a mode for the people picked, a clear for back to the default, and a default change on its own", () => {
    const people = [{ userId: "usr_1", email: "p1@fernwood.example" }, { userId: "usr_2", email: "p2@fernwood.example" }];
    expect(model.module.changesOf({ kind: "people", people, to: "enforce" })).toEqual([{ userIds: ["usr_1", "usr_2"], mode: "enforce" }]);
    expect(model.module.changesOf({ kind: "people", people, to: "default" })).toEqual([{ userIds: ["usr_1", "usr_2"], clear: true }]);
    expect(model.module.changesOf({ kind: "default", to: "off" })).toEqual([{ default: "off" }]);
    expect(model.module.changesOf({ kind: "default", to: "monitor", pause: true })).toEqual([{ default: "monitor" }]);
  });
});

describe("a group is a shortcut to the people in it", () => {
  it("picks each member who has joined, once, matching email without case, and counts members who have not joined", () => {
    const people = [person(1, "monitor", "default"), person(2, "monitor", "default"), person(3, "off", "set")];
    const finance = {
      id: "grp_finance",
      name: "Finance",
      members: [
        { email: "P1@Fernwood.example", name: null },
        { email: "p2@fernwood.example", name: "Two" },
        { email: "p2@fernwood.example", name: "Two" },
        { email: "new@fernwood.example", name: null },
      ],
      memberCount: 4,
      usedBy: { tools: 0, connections: 0 },
      createdAt: ago(10_000),
    } satisfies ConsoleGroupRow;
    const found = model.module.membersOf(finance, people);
    expect(found.people.map((p) => p.userId)).toEqual(["usr_1", "usr_2"]);
    expect(found.notJoined).toBe(1);
  });
});

describe("the preview dialog's words", () => {
  it("names the change in its title and confirm, and marks turning Guard off or stopping blocking as dangerous", () => {
    const words = model.module.askWords;
    const two = [{ userId: "usr_1", email: "p1@fernwood.example" }, { userId: "usr_2", email: "p2@fernwood.example" }];
    expect(words({ kind: "people", people: two, to: "enforce" }, "monitor")).toEqual({ title: "Set 2 people to Enforce?", confirm: "Set to Enforce", danger: false });
    expect(words({ kind: "people", people: [{ userId: "usr_1", email: "p1@fernwood.example", name: "Ada Park" }], to: "off" }, "monitor")).toEqual({
      title: "Turn Guard off for Ada Park?",
      confirm: "Turn off",
      danger: true,
    });
    expect(words({ kind: "people", people: two, to: "default" }, "monitor").title).toBe("Put 2 people back on the default (Monitor)?");
    expect(words({ kind: "people", people: two, to: "default" }, undefined).title).toBe("Put 2 people back on the default?");
    expect(words({ kind: "default", to: "off" }, "monitor")).toEqual({ title: "Change the default to Off?", confirm: "Change the default", danger: true });
    expect(words({ kind: "default", to: "enforce" }, "monitor").danger).toBe(false);
    expect(words({ kind: "default", to: "monitor", pause: true }, "enforce")).toEqual({ title: "Stop blocking for people on the default?", confirm: "Stop blocking", danger: true });
  });

  it("groups people by what happens to them, mode changes first and people who stay as they are last", () => {
    const groups = model.module.effectGroups([
      moved(1, "enforce", "enforce", "Nothing changes", "Zed"),
      moved(2, "monitor", "enforce", "Matches will now be blocked", "Bo"),
      moved(3, "off", "enforce", "Guard starts inspecting their AI traffic; matches will now be blocked"),
      moved(4, "monitor", "enforce", "Matches will now be blocked", "Ada"),
      moved(5, "enforce", "enforce", "Stays Enforce; a change to the organisation default no longer moves them"),
      moved(6, "enforce", "enforce", "Stays Enforce; a change to the organisation default no longer moves them"),
    ]);
    expect(groups.map((g) => [g.effect, g.people.length])).toEqual([
      ["Matches will now be blocked", 2],
      ["Guard starts inspecting their AI traffic; matches will now be blocked", 1],
      ["Stays Enforce; a change to the organisation default no longer moves them", 2],
      ["Nothing changes", 1],
    ]);
    expect(groups[0]?.people.map((p) => p.email)).toEqual(["p4@fernwood.example", "p2@fernwood.example"]);
  });

  it("counts only the people who start blocking for the staff notice reminder", () => {
    expect(model.module.movingTo([moved(1, "monitor", "enforce", "x"), moved(2, "enforce", "enforce", "y"), moved(3, "off", "monitor", "z")], "enforce")).toBe(1);
  });
});

describe("what a default change leaves alone", () => {
  const org = page("enforce", [person(1, "enforce", "set"), person(2, "enforce", "set"), person(3, "off", "set"), person(4, "enforce", "default"), person(5, "monitor", "set")]);

  it("says how many people set on their own keep their mode, for each mode", () => {
    expect(model.module.keptBy({ kind: "default", to: "monitor", pause: true }, org)).toEqual([
      { mode: "enforce", count: 2, words: "2 people set to Enforce on their own keep blocking." },
      { mode: "monitor", count: 1, words: "1 person set to Monitor on their own keeps watching, not blocking." },
      { mode: "off", count: 1, words: "1 person set to Off on their own stays off." },
    ]);
    expect(model.module.keptBy({ kind: "default", to: "enforce" }, org)).toEqual([]);
    expect(model.module.keptBy({ kind: "people", people: [{ userId: "usr_4", email: "p4@fernwood.example" }], to: "off" }, org)).toEqual([]);
  });

  it("knows when a change would move nobody", () => {
    expect(model.module.nothingToApply({ kind: "default", to: "enforce" }, org)).toBe(true);
    expect(model.module.nothingToApply({ kind: "default", to: "off" }, org)).toBe(false);
    expect(model.module.nothingToApply({ kind: "people", people: [{ userId: "usr_1", email: "p1@fernwood.example" }], to: "enforce" }, org)).toBe(true);
    expect(model.module.nothingToApply({ kind: "people", people: [{ userId: "usr_4", email: "p4@fernwood.example" }], to: "enforce" }, org)).toBe(false);
    expect(model.module.nothingToApply({ kind: "people", people: [{ userId: "usr_4", email: "p4@fernwood.example" }], to: "default" }, org)).toBe(true);
    expect(model.module.nothingToApply({ kind: "people", people: [{ userId: "usr_1", email: "p1@fernwood.example" }], to: "default" }, org)).toBe(false);
  });

  it("counts people by mode and links to the filtered list", () => {
    expect(model.module.countsByMode(org.people)).toEqual({ off: 1, monitor: 1, enforce: 3 });
    expect(model.module.protectionHref()).toBe("/people?tab=protection");
    expect(model.module.protectionHref({ mode: "enforce", source: "set" })).toBe("/people?tab=protection&mode=enforce&source=set");
    expect(model.module.protectionHref({ rollout: 12 })).toBe("/people?tab=protection&rollout=12");
  });
});

describe("the rollout view", () => {
  const rollout = (people: GuardProtectionRollout["people"]): GuardProtectionRollout => {
    const all = people.flatMap((p) => p.devices);
    return { revision: 12, applied: all.filter((d) => d.state === "applied").length, pending: all.filter((d) => d.state === "pending").length, people };
  };

  it("reads 9 of 14 Macs now blocking, 5 pending, last seen 2–40 min ago", () => {
    const seen = [2, 5, 11, 25, 40];
    const people = Array.from({ length: 14 }, (_, i) => ({
      userId: `usr_${i}`,
      email: `p${i}@fernwood.example`,
      mode: "enforce" as const,
      devices: [i < 9 ? mac(i, "applied", 1) : mac(i, "pending", seen[i - 9])],
    }));
    const view = model.module.rolloutView(rollout(people), NOW);
    expect(view.lines.map((l) => l.words)).toEqual(["9 of 14 Macs now blocking"]);
    expect(view.pendingWords).toBe("5 pending, last seen 2–40 min ago");
    expect(view.pending.map((p) => p.device.hostname)).toEqual(["mac-13", "mac-12", "mac-11", "mac-10", "mac-9"]);
    expect(view.done).toBe(false);
  });

  it("says when every Mac has it, and names people with no Mac and Macs that never checked in", () => {
    const done = model.module.rolloutView(
      rollout([
        { userId: "usr_1", email: "p1@fernwood.example", mode: "enforce", devices: [mac(1, "applied", 1), mac(2, "applied", 3)] },
        { userId: "usr_2", email: "p2@fernwood.example", mode: "enforce", devices: [] },
      ]),
      NOW,
    );
    expect(done.lines.map((l) => l.words)).toEqual(["All 2 Macs are now blocking"]);
    expect(done.done).toBe(true);
    expect(done.pendingWords).toBeUndefined();
    expect(done.withoutMacWords).toBe("1 person has no Mac yet. Their Mac gets the change when they enrol.");

    const mixed = model.module.rolloutView(
      rollout([
        { userId: "usr_1", email: "p1@fernwood.example", mode: "off", devices: [mac(1, "pending", 3 * 60)] },
        { userId: "usr_2", email: "p2@fernwood.example", mode: "monitor", devices: [mac(2, "applied", 1)] },
        { userId: "usr_3", email: "p3@fernwood.example", mode: "off", devices: [mac(3, "pending", 4 * 24 * 60), mac(4, "pending")] },
      ]),
      NOW,
    );
    expect(mixed.lines.map((l) => [l.mode, l.words])).toEqual([
      ["monitor", "The Mac is now watching, not blocking"],
      ["off", "0 of 3 Macs now off"],
    ]);
    expect(mixed.pendingWords).toBe("3 pending, last seen between 3 h ago and 4 days ago; 1 never checked in");
  });
});
