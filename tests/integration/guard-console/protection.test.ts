import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsoleGroupRow } from "@vibtra/console-api";
import type { GuardClientMode, GuardProtectionChange, GuardProtectionPage, GuardProtectionPreview, GuardProtectionRollout } from "@vibtra/guard-contract";
import { effectOf } from "@vibtra/registry/src/guard/protection.ts";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Mode = GuardClientMode;
type Tls = "block" | "tunnel";
type Who = { userId: string; email: string; name?: string };
type Ask = { kind: "people"; people: Who[]; to: Mode | "default" } | { kind: "default"; to: Mode; pause?: boolean };
type Model = {
  changesOf: (ask: Ask) => GuardProtectionChange[];
  countsByMode: (people: { mode: Mode }[]) => Record<Mode, number>;
  membersOf: (group: ConsoleGroupRow, people: GuardProtectionPage["people"]) => { people: GuardProtectionPage["people"]; notJoined: number };
  askWords: (ask: Ask, defaultMode: Mode | undefined) => { title: string; confirm: string; danger: boolean };
  effectGroups: (people: GuardProtectionPreview["people"]) => { effect: string; from: Mode; to: Mode; people: { email: string }[] }[];
  startingToBlock: (people: GuardProtectionPreview["people"], tls: Tls) => number;
  tlsWords: (people: GuardProtectionPreview["people"], tls: Tls) => string | undefined;
  nothingToApply: (ask: Ask, page: GuardProtectionPage) => boolean;
  movedCount: (ask: Ask, before: GuardProtectionPage, preview: GuardProtectionPreview) => number;
  rolloutScope: (revision: number, ask: Ask, preview: GuardProtectionPreview) => { revision: number; label: string; people: ReadonlySet<string>; cannotTurnOff: ReadonlySet<string> };
  keptBy: (ask: Ask, page: GuardProtectionPage) => { mode: Mode; count: number; words: string }[];
  protectionHref: (filter?: { mode?: Mode; source?: "set" | "default"; rollout?: number }) => string;
  rolloutView: (
    rollout: GuardProtectionRollout,
    now?: number,
    scope?: { people: ReadonlySet<string>; cannotTurnOff: ReadonlySet<string> },
  ) => { lines: { mode: Mode; words: string }[]; pending: { device: { hostname: string } }[]; pendingWords: string | undefined; olderWords: string | undefined; withoutMacWords: string | undefined; done: boolean };
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
    expect(model.module.startingToBlock([moved(1, "monitor", "enforce", "x"), moved(2, "enforce", "enforce", "y"), moved(3, "off", "monitor", "z")], "tunnel")).toBe(1);
  });

  it("counts Off to Monitor as starting to block when connections Guard cannot inspect are blocked", () => {
    const people = [moved(1, "monitor", "enforce", "x"), moved(2, "enforce", "monitor", "y"), moved(3, "off", "monitor", "z"), moved(4, "monitor", "monitor", "w")];
    expect(model.module.startingToBlock(people, "block")).toBe(2);
    expect(model.module.startingToBlock(people, "tunnel")).toBe(1);
  });

  it("states the Uninspectable TLS setting whenever anyone ends up in Monitor, and only then", () => {
    const backToMonitor = [moved(1, "enforce", "monitor", "x"), moved(2, "off", "monitor", "y")];
    expect(model.module.tlsWords(backToMonitor, "block")).toBe("For people in Monitor, connections Guard cannot inspect are blocked (Uninspectable TLS: Block).");
    expect(model.module.tlsWords(backToMonitor, "tunnel")).toBe("For people in Monitor, connections Guard cannot inspect pass without inspection (Uninspectable TLS: Allow without inspection).");
    expect(model.module.tlsWords([moved(1, "monitor", "monitor", "Nothing changes")], "block")).toBe("For people in Monitor, connections Guard cannot inspect are blocked (Uninspectable TLS: Block).");
    expect(model.module.tlsWords([moved(1, "monitor", "enforce", "x"), moved(2, "monitor", "off", "y")], "block")).toBeUndefined();
    expect(model.module.tlsWords([], "block")).toBeUndefined();
  });

  it("keeps people apart whose mode moves differently, even when the effect reads the same", () => {
    const groups = model.module.effectGroups([moved(1, "enforce", "enforce", "Nothing changes"), moved(2, "monitor", "monitor", "Nothing changes"), moved(3, "enforce", "enforce", "Nothing changes")]);
    expect(groups.map((g) => [g.from, g.to, g.people.length])).toEqual([
      ["enforce", "enforce", 2],
      ["monitor", "monitor", 1],
    ]);
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

  it("does not call a change done for someone who is no longer listed", () => {
    const gone = { userId: "usr_99", email: "p99@fernwood.example" };
    expect(model.module.nothingToApply({ kind: "people", people: [{ userId: "usr_1", email: "p1@fernwood.example" }, gone], to: "enforce" }, org)).toBe(false);
    expect(model.module.nothingToApply({ kind: "people", people: [gone], to: "default" }, org)).toBe(false);
  });

  it("counts the people a change moves, from the page it was previewed on", () => {
    const named = [1, 4, 5].map((n) => ({ userId: `usr_${n}`, email: `p${n}@fernwood.example` }));
    const none = { revision: 7, peopleDigest: "a".repeat(64), summary: "x", people: [] };
    expect(model.module.movedCount({ kind: "people", people: named, to: "enforce" }, org, none)).toBe(2);
    expect(model.module.movedCount({ kind: "people", people: named, to: "default" }, org, none)).toBe(2);
    const toMonitor = { ...none, people: [moved(4, "enforce", "monitor", "x"), moved(6, "monitor", "monitor", "y")] };
    expect(model.module.movedCount({ kind: "default", to: "monitor" }, org, toMonitor)).toBe(1);
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

  it("says just now, not 0 min, when the newest pending Mac was seen under a minute ago", () => {
    const view = model.module.rolloutView(
      rollout([{ userId: "usr_1", email: "p1@fernwood.example", mode: "enforce", devices: [{ ...mac(1, "pending"), lastSeenAt: new Date(NOW - 20_000).toISOString() }, mac(2, "pending", 40)] }]),
      NOW,
    );
    expect(view.pendingWords).toBe("2 pending, last seen between just now and 40 min ago");
  });

  it("draws no line for a mode whose people have no Mac", () => {
    const view = model.module.rolloutView(
      rollout([
        { userId: "usr_1", email: "p1@fernwood.example", mode: "enforce", devices: [mac(1, "applied", 1)] },
        { userId: "usr_2", email: "p2@fernwood.example", mode: "monitor", devices: [] },
      ]),
      NOW,
    );
    expect(view.lines.map((l) => [l.mode, l.words])).toEqual([["enforce", "The Mac is now blocking"]]);
  });

  const offMac = (n: number) => ({ deviceId: `gdev_${String(n).padStart(16, "0")}`, hostname: `mac-${n}`, state: "applied" as const, clientMode: "off" as const, lastSeenAt: ago(1) });

  it("counts only the people the change moved, and an older Mac that cannot turn off is neither pending nor counted", () => {
    const after = rollout([
      { userId: "usr_1", email: "p1@fernwood.example", mode: "off", devices: [mac(1, "pending", 5)] },
      { userId: "usr_2", email: "p2@fernwood.example", mode: "off", devices: [offMac(2)] },
      { userId: "usr_3", email: "p3@fernwood.example", mode: "monitor", devices: [mac(3, "pending", 2)] },
    ]);
    const scoped = model.module.rolloutView(after, NOW, { people: new Set(["usr_1", "usr_2"]), cannotTurnOff: new Set(["usr_1"]) });
    expect(scoped.lines.map((l) => l.words)).toEqual(["The Mac is now off"]);
    expect(scoped.pendingWords).toBeUndefined();
    expect(scoped.olderWords).toBe("1 older Mac can’t turn off: it keeps inspecting until Guard is updated on it.");
    expect(scoped.done).toBe(true);

    const everyone = model.module.rolloutView(after, NOW);
    expect(everyone.lines.map((l) => l.words)).toEqual(["0 of 1 Mac now watching, not blocking", "1 of 2 Macs now off"]);
    expect(everyone.olderWords).toBeUndefined();
    expect(everyone.done).toBe(false);

    const two = model.module.rolloutView(rollout([{ userId: "usr_1", email: "p1@fernwood.example", mode: "off", devices: [mac(1, "pending", 5), mac(2, "pending", 9)] }]), NOW, {
      people: new Set(["usr_1"]),
      cannotTurnOff: new Set(["usr_1"]),
    });
    expect(two.olderWords).toBe("2 older Macs can’t turn off: they keep inspecting until Guard is updated on them.");
    expect(two.lines).toEqual([]);
  });
});

describe("what a rollout follows", () => {
  const set = (mode: Mode) => ({ mode, source: "set" as const });
  const onDefault = (mode: Mode) => ({ mode, source: "default" as const });
  const preview = (people: GuardProtectionPreview["people"]): GuardProtectionPreview => ({ revision: 7, peopleDigest: "a".repeat(64), summary: "x", people });

  it("follows the people whose mode moves, and knows from the registry's own words which of them have a Mac that cannot turn off", () => {
    const shown = preview([
      moved(1, "monitor", "off", effectOf(onDefault("monitor"), set("off"), true), "Ada"),
      moved(2, "enforce", "off", effectOf(set("enforce"), set("off"), true)),
      moved(3, "monitor", "off", effectOf(onDefault("monitor"), set("off"), false)),
      moved(4, "off", "off", effectOf(set("off"), set("off"), true)),
    ]);
    const who = [1, 2, 3, 4].map((n) => ({ userId: `usr_${n}`, email: `p${n}@fernwood.example` }));
    const scope = model.module.rolloutScope(8, { kind: "people", people: who, to: "off" }, shown);
    expect(scope.revision).toBe(8);
    expect(scope.label).toBe("4 people set to Off");
    expect([...scope.people].sort()).toEqual(["usr_1", "usr_2", "usr_3"]);
    expect([...scope.cannotTurnOff].sort()).toEqual(["usr_1", "usr_2"]);
  });

  it("leaves out people put back on the default whose mode stays the same, and names the change", () => {
    const shown = preview([moved(1, "enforce", "monitor", effectOf(set("enforce"), onDefault("monitor"), false), "Grace Ho"), moved(2, "monitor", "monitor", effectOf(set("monitor"), onDefault("monitor"), false))]);
    const grace = { userId: "usr_1", email: "p1@fernwood.example", name: "Grace Ho" };
    expect([...model.module.rolloutScope(8, { kind: "people", people: [grace, { userId: "usr_2", email: "p2@fernwood.example" }], to: "default" }, shown).people]).toEqual(["usr_1"]);
    expect(model.module.rolloutScope(8, { kind: "people", people: [grace], to: "default" }, shown).label).toBe("Grace Ho back on the default");
    expect(model.module.rolloutScope(8, { kind: "people", people: [grace], to: "enforce" }, shown).label).toBe("Grace Ho set to Enforce");
    expect(model.module.rolloutScope(8, { kind: "default", to: "enforce" }, shown).label).toBe("Default changed to Enforce");
    expect(model.module.rolloutScope(8, { kind: "default", to: "monitor", pause: true }, shown).label).toBe("Stopped blocking for people on the default");
  });
});
