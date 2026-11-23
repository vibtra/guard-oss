import { effectiveMode, type GuardClientMode, type GuardProtectionChange, type GuardSettings } from "@vibtra/guard-contract";
import { digestOf } from "@vibtra/guard-contract/signing";

interface Standing {
  mode: GuardClientMode;
  source: "set" | "default";
}

interface PlannedPerson {
  userId: string;
  email: string;
  name?: string;
  from: Standing;
  to: Standing;
}

export interface ProtectionPlan {
  defaultMode: { from: GuardClientMode; to: GuardClientMode };
  people: PlannedPerson[];
  set: Array<{ userId: string; mode: GuardClientMode }>;
  clear: string[];
}

export const movesStanding = (person: PlannedPerson): boolean => person.from.mode !== person.to.mode || person.from.source !== person.to.source;

export const peopleDigestOf = (plan: ProtectionPlan, unreproducibleTls: GuardSettings["unreproducibleTls"]): string =>
  digestOf({
    unreproducibleTls,
    people: plan.people
      .filter(movesStanding)
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
      .map((p) => [p.userId, p.from.mode, p.from.source, p.to.mode, p.to.source]),
  });

export const planProtection = (input: {
  members: ReadonlyArray<{ userId: string; email: string; name: string | null }>;
  rows: ReadonlyMap<string, { mode: GuardClientMode }>;
  orgDefault: GuardClientMode;
  changes: readonly GuardProtectionChange[];
}): { plan: ProtectionPlan } | { notMembers: string[] } => {
  const nextDefault = input.changes.reduce<GuardClientMode>((mode, change) => ("default" in change ? change.default : mode), input.orgDefault);
  const named = new Map<string, Standing>();
  for (const change of input.changes) {
    if ("default" in change) continue;
    for (const userId of change.userIds) named.set(userId, "mode" in change ? { mode: change.mode, source: "set" } : { mode: nextDefault, source: "default" });
  }
  const members = new Set(input.members.map((member) => member.userId));
  const notMembers = [...named.keys()].filter((userId) => !members.has(userId));
  if (notMembers.length > 0) return { notMembers };
  const people = input.members.flatMap((member): PlannedPerson[] => {
    const row = input.rows.get(member.userId);
    const to = named.get(member.userId) ?? (row === undefined && nextDefault !== input.orgDefault ? { mode: nextDefault, source: "default" } : undefined);
    if (to === undefined) return [];
    return [{ userId: member.userId, email: member.email, ...(member.name ? { name: member.name } : {}), from: effectiveMode(row, input.orgDefault), to }];
  });
  const moved = people.filter(movesStanding);
  return {
    plan: {
      defaultMode: { from: input.orgDefault, to: nextDefault },
      people,
      set: moved.flatMap((person) => (person.to.source === "set" ? [{ userId: person.userId, mode: person.to.mode }] : [])),
      clear: moved.flatMap((person) => (person.from.source === "set" && person.to.source === "default" ? [person.userId] : [])),
    },
  };
};

const MODE_WORD: Readonly<Record<GuardClientMode, string>> = { off: "Off", monitor: "Monitor", enforce: "Enforce" };

const NOTHING = "Nothing changes";
const STOPS = "Guard stops checking their AI traffic; nothing is recorded";
const EFFECT: Readonly<Record<GuardClientMode, Readonly<Record<GuardClientMode, string>>>> = {
  off: { off: NOTHING, monitor: "Guard starts inspecting their AI traffic and records what it would block, without blocking", enforce: "Guard starts inspecting their AI traffic; matches will now be blocked" },
  monitor: { off: STOPS, monitor: NOTHING, enforce: "Matches will now be blocked" },
  enforce: { off: `${STOPS} or blocked`, monitor: "Matches will be recorded, no longer blocked", enforce: NOTHING },
};

const STILL_INSPECTED = "; their Mac keeps inspecting until Guard is updated on it";
const ON_AN_OLDER_MAC: Readonly<Partial<Record<GuardClientMode, Partial<Record<GuardClientMode, string>>>>> = {
  monitor: { off: `Nothing is recorded${STILL_INSPECTED}` },
  enforce: { off: `Nothing is recorded or blocked${STILL_INSPECTED}` },
};

export const effectOf = (from: Standing, to: Standing, olderMac: boolean): string => {
  if (from.mode !== to.mode || from.source === to.source) return (olderMac ? ON_AN_OLDER_MAC[from.mode]?.[to.mode] : undefined) ?? EFFECT[from.mode][to.mode];
  return to.source === "set" ? `Stays ${MODE_WORD[to.mode]}; a change to the organisation default no longer moves them` : `Stays ${MODE_WORD[to.mode]}, and follows the organisation default from now on`;
};

const peopleWord = (n: number): string => `${n} ${n === 1 ? "person" : "people"}`;

const movementOf = (person: PlannedPerson): string => {
  if (person.from.mode !== person.to.mode) return `from ${MODE_WORD[person.from.mode]} to ${MODE_WORD[person.to.mode]}`;
  return person.to.source === "set" ? `keep ${MODE_WORD[person.to.mode]}, set for them` : `keep ${MODE_WORD[person.to.mode]}, back on the default`;
};

export const summaryOf = (plan: ProtectionPlan): string => {
  const moved = plan.people.filter(movesStanding);
  const counts = new Map<string, number>();
  for (const person of moved) counts.set(movementOf(person), (counts.get(movementOf(person)) ?? 0) + 1);
  const unchanged = plan.people.length - moved.length;
  const sentences = [
    ...(plan.defaultMode.from === plan.defaultMode.to ? [] : [`The organisation default changes from ${MODE_WORD[plan.defaultMode.from]} to ${MODE_WORD[plan.defaultMode.to]}.`]),
    ...(moved.length === 0 ? [] : [`Changes ${peopleWord(moved.length)}: ${[...counts].map(([movement, n]) => `${n} ${movement}`).join(", ")}.`]),
    ...(unchanged === 0 ? [] : [`${peopleWord(unchanged)} ${unchanged === 1 ? "is" : "are"} already as asked.`]),
  ];
  return sentences.length === 0 ? `${NOTHING}.` : sentences.join(" ");
};
