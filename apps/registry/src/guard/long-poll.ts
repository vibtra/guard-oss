// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyBaseLogger } from "fastify";
import type { GuardNoticeFeed, GuardPolicyNotice } from "./policy-notices.js";

interface GuardStamp {
  readonly rules: number;
  readonly revision: number;
}

type GuardWaitOutcome = "changed" | "unchanged" | "recheck" | "unsupported" | "closing";

interface GuardWaiter {
  readonly orgId: string;
  readonly userId: string;
  readonly deviceId: string;
}

export interface GuardWaits {
  wait(waiter: GuardWaiter, stamp: GuardStamp, holdMs: number, onCancel: (cancel: () => void) => void): Promise<GuardWaitOutcome>;
  start(): void;
  close(): Promise<void>;
}

interface GuardWaitsOptions {
  feed: GuardNoticeFeed;
  load(orgId: string, userIds: readonly string[]): Promise<ReadonlyMap<string, GuardStamp>>;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
}

interface Parked {
  readonly stamp: GuardStamp;
  settle(outcome: GuardWaitOutcome): void;
}

interface Person {
  stamp: GuardStamp | undefined;
  readonly waits: Map<string, Parked>;
}

type State = "connecting" | "live" | "off" | "closed";

const same = (a: GuardStamp, b: GuardStamp): boolean => a.rules === b.rules && a.revision === b.revision;
const newest = (held: GuardStamp | undefined, next: GuardStamp): GuardStamp =>
  held === undefined ? next : { rules: Math.max(held.rules, next.rules), revision: Math.max(held.revision, next.revision) };

export const createGuardWaits = (options: GuardWaitsOptions): GuardWaits => {
  let state: State = "connecting";
  let notices = 0;
  const orgs = new Map<string, Map<string, Person>>();

  const everyWait = (): Parked[] => [...orgs.values()].flatMap((people) => [...people.values()].flatMap((person) => [...person.waits.values()]));
  const settleAll = (outcome: GuardWaitOutcome): void => {
    for (const parked of everyWait()) parked.settle(outcome);
  };
  const forgetStamps = (): void => {
    for (const people of orgs.values()) for (const person of people.values()) person.stamp = undefined;
  };
  const answerStale = (person: Person): void => {
    const stamp = person.stamp;
    if (stamp === undefined) return;
    for (const parked of person.waits.values()) if (!same(parked.stamp, stamp)) parked.settle("changed");
  };

  const consistentRead = async (orgId: string, userIds: readonly string[]): Promise<ReadonlyMap<string, GuardStamp> | undefined> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = notices;
      const loaded = await options.load(orgId, userIds);
      if (notices === before) return loaded;
    }
    return undefined;
  };

  const reload = async (orgId: string): Promise<void> => {
    const people = orgs.get(orgId);
    if (people === undefined) return;
    const userIds = [...people.keys()];
    for (const person of people.values()) person.stamp = undefined;
    const loaded = await consistentRead(orgId, userIds).catch(() => undefined);
    for (const userId of userIds) {
      const person = orgs.get(orgId)?.get(userId);
      if (person === undefined) continue;
      const stamp = loaded?.get(userId);
      if (stamp === undefined) {
        for (const parked of person.waits.values()) parked.settle("recheck");
        continue;
      }
      person.stamp = newest(person.stamp, stamp);
      answerStale(person);
    }
  };

  const onNotice = (notice: GuardPolicyNotice): void => {
    notices += 1;
    const people = orgs.get(notice.org);
    if (people === undefined) return;
    if ("peopleChanged" in notice) {
      void reload(notice.org);
      return;
    }
    for (const [userId, person] of people) {
      if (person.stamp === undefined) continue;
      if ("rules" in notice) person.stamp = newest(person.stamp, { rules: notice.rules, revision: 0 });
      else if (notice.people[userId] !== undefined) person.stamp = newest(person.stamp, { rules: 0, revision: notice.people[userId] });
      answerStale(person);
    }
  };

  const personFor = (waiter: GuardWaiter): Person => {
    let people = orgs.get(waiter.orgId);
    if (people === undefined) orgs.set(waiter.orgId, (people = new Map()));
    let person = people.get(waiter.userId);
    if (person === undefined) people.set(waiter.userId, (person = { stamp: undefined, waits: new Map() }));
    return person;
  };
  const release = (waiter: GuardWaiter, person: Person): void => {
    const people = orgs.get(waiter.orgId);
    if (person.waits.size > 0 || people?.get(waiter.userId) !== person) return;
    people.delete(waiter.userId);
    if (people.size === 0) orgs.delete(waiter.orgId);
  };

  const refusal = (): GuardWaitOutcome | undefined => (state === "off" ? "unsupported" : state === "closed" ? "closing" : undefined);

  const currentStamp = async (waiter: GuardWaiter): Promise<GuardStamp | undefined> => {
    const held = state === "live" ? orgs.get(waiter.orgId)?.get(waiter.userId)?.stamp : undefined;
    if (held !== undefined) return held;
    return (await consistentRead(waiter.orgId, [waiter.userId]))?.get(waiter.userId);
  };

  return {
    async wait(waiter, stamp, holdMs, onCancel) {
      const before = refusal();
      if (before !== undefined) return before;
      const loaded = await currentStamp(waiter);
      const after = refusal();
      if (after !== undefined) return after;
      if (loaded === undefined) return "recheck";
      const person = personFor(waiter);
      const current = newest(person.stamp, loaded);
      if (state === "live") person.stamp = current;
      if (!same(current, stamp)) {
        release(waiter, person);
        return "changed";
      }
      return new Promise<GuardWaitOutcome>((resolve) => {
        let done = false;
        const parked: Parked = {
          stamp,
          settle: (outcome) => {
            if (done) return;
            done = true;
            if (person.waits.get(waiter.deviceId) === parked) person.waits.delete(waiter.deviceId);
            clearTimeout(timer);
            release(waiter, person);
            resolve(outcome);
          },
        };
        const timer = setTimeout(() => parked.settle("unchanged"), holdMs);
        const previous = person.waits.get(waiter.deviceId);
        person.waits.set(waiter.deviceId, parked);
        previous?.settle("unchanged");
        onCancel(() => parked.settle("unchanged"));
      });
    },
    start() {
      const connected = (message: string): void => {
        if (state === "off" || state === "closed") return;
        state = "live";
        notices += 1;
        forgetStamps();
        settleAll("recheck");
        options.log.info(message);
      };
      options.feed.start({
        notice: onNotice,
        live: () => connected("guard long polling is on"),
        lost: (reason) => {
          if (state === "off" || state === "closed") return;
          state = "connecting";
          notices += 1;
          forgetStamps();
          options.log.warn({ reason }, "guard policy listener lost; reconnecting, and Macs keep their 60 s check-in");
        },
        restored: () => connected("guard policy listener back; parked waits told to ask again"),
        off: (reason) => {
          if (state === "closed") return;
          state = "off";
          settleAll("unsupported");
          options.log.warn(
            { reason },
            "guard long polling is off: notices do not reach this server. Macs still get changes at their 60 s check-in. Point GUARD_LISTEN_DATABASE_URL at Postgres directly, not through a transaction-mode pooler, and restart",
          );
        },
      });
    },
    async close() {
      state = "closed";
      settleAll("closing");
      await options.feed.close();
    },
  };
};
