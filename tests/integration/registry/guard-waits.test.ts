import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createGuardWaits } from "@vibtra/registry/src/guard/long-poll.ts";
import type { GuardNoticeSink, GuardPolicyNotice } from "@vibtra/registry/src/guard/policy-notices.ts";

interface Stamp {
  rules: number;
  revision: number;
}

const ORG = "org_waits";
const anaMac = { orgId: ORG, userId: "ana", deviceId: "dev_ana_mac" };
const anaMini = { orgId: ORG, userId: "ana", deviceId: "dev_ana_mini" };
const HELD: Stamp = { rules: 1, revision: 4 };
const NEWER: Stamp = { rules: 1, revision: 5 };

const scripted = () => {
  let sink: GuardNoticeSink | undefined;
  const db = new Map<string, Stamp>([["ana", HELD]]);
  const reads: string[][] = [];
  let duringRead: Array<() => void> = [];
  let failReads = false;
  const waits = createGuardWaits({
    feed: { start: (target) => void (sink = target), close: async () => undefined },
    load: async (_org, userIds) => {
      reads.push([...userIds]);
      if (failReads) throw new Error("the stamp read failed");
      const snapshot = new Map(userIds.map((id) => [id, { ...(db.get(id) ?? { rules: 0, revision: 0 }) }] as const));
      const [during, ...rest] = duringRead;
      duringRead = rest;
      during?.();
      await delay(1);
      return snapshot;
    },
    log: { info: () => undefined, warn: () => undefined },
  });
  waits.start();
  const feed = (): GuardNoticeSink => {
    if (sink === undefined) throw new Error("the waits did not start their feed");
    return sink;
  };
  return {
    waits,
    db,
    reads,
    feed,
    notice: (notice: GuardPolicyNotice) => feed().notice(notice),
    duringReads: (...steps: Array<() => void>) => void (duringRead = steps),
    failReads: (fail: boolean) => void (failReads = fail),
    park: (waiter = anaMac, stamp = HELD, holdMs = 5_000) => waits.wait(waiter, stamp, holdMs, () => undefined),
  };
};

const outcome = async <T>(answer: Promise<T>, ms = 50): Promise<T | "parked"> => await Promise.race([answer, delay(ms).then(() => "parked" as const)]);

describe("guard waits against a scripted feed and stamp store", () => {
  it("reads the stamp again when a change commits and its notice lands during the read, and answers from the newer stamp", async () => {
    const s = scripted();
    s.feed().live();
    s.duringReads(() => {
      s.db.set("ana", NEWER);
      s.notice({ org: ORG, people: { ana: NEWER.revision } });
    });
    expect(await outcome(s.park())).toBe("changed");
    expect(s.reads, "the first read was overtaken by a notice").toHaveLength(2);
  });

  it("answers recheck instead of parking when notices land during both reads", async () => {
    const s = scripted();
    s.feed().live();
    s.duringReads(
      () => s.notice({ org: "org_other", rules: 9 }),
      () => s.notice({ org: "org_other", rules: 10 }),
    );
    expect(await outcome(s.park())).toBe("recheck");
  });

  it("keeps one parked wait per device: a second wait from the same device answers the first unchanged", async () => {
    const s = scripted();
    s.feed().live();
    const first = s.park(anaMac);
    expect(await outcome(first)).toBe("parked");
    const other = s.park(anaMini);
    const second = s.park(anaMac);
    expect(await outcome(first), "the earlier wait from the same Mac").toBe("unchanged");
    expect([await outcome(second), await outcome(other)], "the newer wait and the other device's wait stay parked").toEqual(["parked", "parked"]);
    expect(s.reads, "the newer wait used the stamp the parked ones hold").toHaveLength(1);
    s.notice({ org: ORG, people: { ana: NEWER.revision } });
    expect([await outcome(second), await outcome(other)]).toEqual(["changed", "changed"]);
  });

  it("tells a wait parked before the feed is live to recheck once it is live, and reads the stamp again for the next wait", async () => {
    const s = scripted();
    const early = s.park();
    expect(await outcome(early), "parks while the listener is still connecting").toBe("parked");
    s.db.set("ana", NEWER);
    s.feed().live();
    expect(await outcome(early)).toBe("recheck");
    expect(await outcome(s.park()), "the next wait reads the stamp the missed change moved").toBe("changed");
  });

  it("answers parked waits unsupported when long polling turns off, and every later wait at once", async () => {
    const s = scripted();
    const parked = s.park();
    expect(await outcome(parked)).toBe("parked");
    s.feed().off("a test notice did not come back within 3 s");
    expect(await outcome(parked)).toBe("unsupported");
    expect(await outcome(s.park())).toBe("unsupported");
  });

  it("tells parked waits to recheck when the reload after a peopleChanged notice fails", async () => {
    const s = scripted();
    s.feed().live();
    const parked = s.park();
    expect(await outcome(parked)).toBe("parked");
    s.failReads(true);
    s.notice({ org: ORG, peopleChanged: true });
    expect(await outcome(parked)).toBe("recheck");
  });

  it("forgets stamps while the feed is lost and tells parked waits to recheck when it is back, whether or not it was ever live", async () => {
    for (const wasLive of [true, false]) {
      const s = scripted();
      if (wasLive) s.feed().live();
      const parked = s.park();
      expect(await outcome(parked), `live before: ${wasLive}`).toBe("parked");
      s.feed().lost("the listen connection closed");
      s.db.set("ana", NEWER);
      expect(await outcome(s.park(anaMini)), `live before: ${wasLive}: a wait during the gap reads the store`).toBe("changed");
      if (wasLive) s.feed().restored();
      else s.feed().live();
      expect(await outcome(parked), `live before: ${wasLive}`).toBe("recheck");
    }
  });
});
