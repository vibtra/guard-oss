import type { ConsoleGroupRow } from "@vibtra/console-api";
import type { GuardClientMode, GuardProtectionChange, GuardProtectionPage, GuardProtectionPreview, GuardProtectionRollout } from "@vibtra/guard-contract";

export type Mode = GuardClientMode;
export type ProtectionPerson = GuardProtectionPage["people"][number];
type PreviewPerson = GuardProtectionPreview["people"][number];
export type Source = ProtectionPerson["source"];

export interface Who {
  userId: string;
  email: string;
  name?: string | undefined;
}

export const MODES: readonly Mode[] = ["enforce", "monitor", "off"];

export const MODE_LABEL: Readonly<Record<Mode, string>> = { off: "Off", monitor: "Monitor", enforce: "Enforce" };

const NOW_DOING: Readonly<Record<Mode, string>> = { enforce: "blocking", monitor: "watching, not blocking", off: "off" };

const KEEPS: Readonly<Record<Mode, readonly [string, string]>> = {
  enforce: ["keeps blocking", "keep blocking"],
  monitor: ["keeps watching, not blocking", "keep watching, not blocking"],
  off: ["stays off", "stay off"],
};

export type Ask =
  | { kind: "people"; people: readonly Who[]; to: Mode | "default" }
  | { kind: "default"; to: Mode; pause?: boolean };

export const isMode = (value: string | null): value is Mode => value === "off" || value === "monitor" || value === "enforce";

export const isSource = (value: string | null): value is Source => value === "set" || value === "default";

export const nameOf = (who: Who): string => who.name ?? who.email;

const count = (n: number, one: string, other: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : other}`;

export const peopleWords = (n: number): string => count(n, "person", "people");

export const changesOf = (ask: Ask): GuardProtectionChange[] => {
  if (ask.kind === "default") return [{ default: ask.to }];
  const userIds = ask.people.map((who) => who.userId);
  return ask.to === "default" ? [{ userIds, clear: true }] : [{ userIds, mode: ask.to }];
};

export const countsByMode = (people: readonly Pick<ProtectionPerson, "mode">[]): Record<Mode, number> => {
  const counts: Record<Mode, number> = { off: 0, monitor: 0, enforce: 0 };
  for (const person of people) counts[person.mode] += 1;
  return counts;
};

export const membersOf = (group: ConsoleGroupRow, people: readonly ProtectionPerson[]): { people: ProtectionPerson[]; notJoined: number } => {
  const byEmail = new Map(people.map((person) => [person.email.toLowerCase(), person] as const));
  const found = new Map<string, ProtectionPerson>();
  let notJoined = 0;
  for (const member of group.members ?? []) {
    const person = byEmail.get(member.email.toLowerCase());
    if (person === undefined) notJoined += 1;
    else found.set(person.userId, person);
  }
  return { people: [...found.values()], notJoined };
};

interface AskWords {
  title: string;
  confirm: string;
  danger: boolean;
}

export const askWords = (ask: Ask, defaultMode: Mode | undefined): AskWords => {
  if (ask.kind === "default") {
    if (ask.pause === true) return { title: "Stop blocking for people on the default?", confirm: "Stop blocking", danger: true };
    return { title: `Change the default to ${MODE_LABEL[ask.to]}?`, confirm: "Change the default", danger: ask.to === "off" };
  }
  const who = ask.people.length === 1 && ask.people[0] !== undefined ? nameOf(ask.people[0]) : peopleWords(ask.people.length);
  if (ask.to === "default") return { title: `Put ${who} back on the default${defaultMode === undefined ? "" : ` (${MODE_LABEL[defaultMode]})`}?`, confirm: "Back to the default", danger: false };
  if (ask.to === "off") return { title: `Turn Guard off for ${who}?`, confirm: "Turn off", danger: true };
  return { title: `Set ${who} to ${MODE_LABEL[ask.to]}?`, confirm: `Set to ${MODE_LABEL[ask.to]}`, danger: false };
};

export interface EffectGroup {
  key: string;
  effect: string;
  from: Mode;
  to: Mode;
  people: PreviewPerson[];
}

export const effectGroups = (people: readonly PreviewPerson[]): EffectGroup[] => {
  const groups = new Map<string, EffectGroup>();
  for (const person of people) {
    const key = `${person.from}>${person.to}>${person.effect}`;
    const group = groups.get(key) ?? { key, effect: person.effect, from: person.from, to: person.to, people: [] };
    group.people.push(person);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.people.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const moves = (group: EffectGroup): number => (group.from === group.to ? 1 : 0);
  return [...groups.values()].sort((a, b) => moves(a) - moves(b) || b.people.length - a.people.length || a.effect.localeCompare(b.effect));
};

export const movingTo = (people: readonly PreviewPerson[], mode: Mode): number => people.filter((p) => p.from !== mode && p.to === mode).length;

export const nothingToApply = (ask: Ask, page: GuardProtectionPage): boolean => {
  if (ask.kind === "default") return page.defaultMode === ask.to;
  const standing = new Map(page.people.map((person) => [person.userId, person] as const));
  return ask.people.every((who) => {
    const now = standing.get(who.userId);
    if (now === undefined) return false;
    return ask.to === "default" ? now.source === "default" : now.source === "set" && now.mode === ask.to;
  });
};

interface Kept {
  mode: Mode;
  count: number;
  words: string;
}

export const keptBy = (ask: Ask, page: GuardProtectionPage): Kept[] => {
  if (ask.kind !== "default" || ask.to === page.defaultMode) return [];
  const set = countsByMode(page.people.filter((person) => person.source === "set"));
  return MODES.filter((mode) => set[mode] > 0).map((mode) => ({
    mode,
    count: set[mode],
    words: `${peopleWords(set[mode])} set to ${MODE_LABEL[mode]} on their own ${KEEPS[mode][set[mode] === 1 ? 0 : 1]}.`,
  }));
};

export const protectionHref = (filter: { mode?: Mode; source?: Source; rollout?: number } = {}): string => {
  const params = new URLSearchParams({ tab: "protection" });
  if (filter.mode !== undefined) params.set("mode", filter.mode);
  if (filter.source !== undefined) params.set("source", filter.source);
  if (filter.rollout !== undefined) params.set("rollout", String(filter.rollout));
  return `/people?${params.toString()}`;
};

type RolloutDevice = GuardProtectionRollout["people"][number]["devices"][number];

interface PendingMac {
  person: Who;
  device: RolloutDevice;
}

export interface RolloutView {
  lines: { mode: Mode; words: string; applied: number; macs: number }[];
  pending: PendingMac[];
  pendingWords: string | undefined;
  withoutMac: number;
  withoutMacWords: string | undefined;
  done: boolean;
}

const minutesAgo = (iso: string, now: number): number => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

const agoWords = (minutes: number): string =>
  minutes < 1 ? "just now" : minutes < 90 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / (60 * 24))} days ago`;

const seenWords = (pending: readonly PendingMac[], now: number): string | undefined => {
  const ages = pending.flatMap((mac) => (mac.device.lastSeenAt === undefined ? [] : [minutesAgo(mac.device.lastSeenAt, now)])).sort((a, b) => a - b);
  const never = pending.length - ages.length;
  const newest = ages[0];
  const oldest = ages[ages.length - 1];
  const neverWords = never === 0 ? undefined : never === pending.length ? (never === 1 ? "never checked in" : "none has checked in yet") : `${never} never checked in`;
  if (newest === undefined || oldest === undefined) return neverWords;
  const sameMinutes = newest >= 1 && oldest < 90;
  const span =
    agoWords(newest) === agoWords(oldest) ? `last seen ${agoWords(oldest)}` : sameMinutes ? `last seen ${newest}–${oldest} min ago` : `last seen between ${agoWords(newest)} and ${agoWords(oldest)}`;
  return neverWords === undefined ? span : `${span}; ${neverWords}`;
};

export const rolloutView = (rollout: GuardProtectionRollout, now: number = Date.now()): RolloutView => {
  const byMode = new Map<Mode, { applied: number; macs: number }>();
  const pending: PendingMac[] = [];
  let withoutMac = 0;
  for (const person of rollout.people) {
    if (person.devices.length === 0) withoutMac += 1;
    const tally = byMode.get(person.mode) ?? { applied: 0, macs: 0 };
    for (const device of person.devices) {
      tally.macs += 1;
      if (device.state === "applied") tally.applied += 1;
      else pending.push({ person: { userId: person.userId, email: person.email, name: person.name }, device });
    }
    byMode.set(person.mode, tally);
  }
  pending.sort((a, b) => (a.device.lastSeenAt ?? "").localeCompare(b.device.lastSeenAt ?? "") || nameOf(a.person).localeCompare(nameOf(b.person)));
  const lines = MODES.flatMap((mode) => {
    const tally = byMode.get(mode);
    if (tally === undefined || tally.macs === 0) return [];
    const words =
      tally.applied === tally.macs
        ? `${tally.macs === 1 ? "The Mac is" : `All ${tally.macs} Macs are`} now ${NOW_DOING[mode]}`
        : `${tally.applied} of ${count(tally.macs, "Mac", "Macs")} now ${NOW_DOING[mode]}`;
    return [{ mode, words, ...tally }];
  });
  const seen = seenWords(pending, now);
  return {
    lines,
    pending,
    pendingWords: pending.length === 0 ? undefined : `${pending.length} pending${seen === undefined ? "" : `, ${seen}`}`,
    withoutMac,
    withoutMacWords: withoutMac === 0 ? undefined : `${peopleWords(withoutMac)} ${withoutMac === 1 ? "has" : "have"} no Mac yet. Their Mac gets the change when they enrol.`,
    done: pending.length === 0,
  };
};
