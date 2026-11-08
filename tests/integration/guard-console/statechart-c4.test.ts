import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION, type GuardDeviceRow } from "@vibtra/guard-contract";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, preflightBody, type EnrolledDevice } from "../registry/guard-device.ts";
import { manualClock } from "../registry/server-options.ts";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Fleet = { deviceState: (row: GuardDeviceRow) => { key: string; label: string } };

const MINUTE = 60_000;
const clock = manualClock();
let registry: TestRegistry;
let fleet: ConsoleModule<Fleet>;

beforeAll(async () => {
  registry = await startRegistry({ domain: "guard-console-late.example", configure: (options) => ({ ...options, clock }) });
  fleet = await loadConsoleModule<Fleet>("/src/people/fleet.tsx");
});

afterAll(async () => {
  await fleet?.close();
  await registry?.close();
});

const sync = async (laptop: EnrolledDevice): Promise<void> => {
  const post = await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, {
    protocol: GUARD_PROTOCOL_VERSION,
    bundleVersion: 0,
    catalogueVersion: "x",
    rulesReceived: 0,
    rulesProcessed: 0,
    clientMode: "monitor",
  });
  expect(post.status, post.text).toBe(200);
};

const rowOf = async (laptop: EnrolledDevice): Promise<GuardDeviceRow> => {
  const page = (await registry.consoleGet(registry.people.owner, "/guard/devices")).body as { rows: GuardDeviceRow[] };
  const row = page.rows.find((device) => device.deviceId === laptop.deviceId);
  if (row === undefined) throw new Error(`${laptop.deviceId} is not on the devices page`);
  return row;
};

const pillOf = async (laptop: EnrolledDevice): Promise<string> => fleet.module.deviceState(await rowOf(laptop)).key;

describe("a Mac that stops syncing is Late on the console (VIB-52, statechart rule 8)", () => {
  it("rule 8: a Mac that missed 3 syncs of 60 s is Late, not still Monitoring, and a sync clears it", async () => {
    const { owner, member } = registry.people;
    const laptop = await enrolDevice(registry, owner, member, "member-late");
    await sync(laptop);
    expect(await pillOf(laptop)).toBe("monitoring");
    clock.advance(3 * MINUTE - 1);
    expect(await pillOf(laptop)).toBe("monitoring");
    clock.advance(1);
    expect(await rowOf(laptop)).toMatchObject({ late: true, quiet: false });
    expect(await pillOf(laptop)).toBe("late");
    await sync(laptop);
    expect(await pillOf(laptop)).toBe("monitoring");
  });

  it("the org admin can set Late to 15 minutes, and only 3 or 15", async () => {
    const { owner, admin, member } = registry.people;
    const set = await registry.consoleWrite(owner, "PUT", "/guard/settings", { lateAfterMinutes: 15 });
    expect(set.status, set.text).toBe(200);
    expect((set.body as { settings: { lateAfterMinutes: number } }).settings.lateAfterMinutes).toBe(15);
    expect((await registry.consoleWrite(admin, "PUT", "/guard/settings", { lateAfterMinutes: 10 })).status).toBe(400);
    const laptop = await enrolDevice(registry, owner, member, "member-late-15");
    await sync(laptop);
    clock.advance(14 * MINUTE);
    expect(await pillOf(laptop)).toBe("monitoring");
    clock.advance(MINUTE);
    expect(await rowOf(laptop)).toMatchObject({ late: true });
    expect(await pillOf(laptop)).toBe("late");
  });

  it("a Mac silent past the quiet setting shows Quiet, the deeper stage of Late", async () => {
    const { owner, member } = registry.people;
    expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { lateAfterMinutes: 3, quietAfterMinutes: 60 })).status).toBe(200);
    const laptop = await enrolDevice(registry, owner, member, "member-late-quiet");
    await sync(laptop);
    clock.advance(60 * MINUTE);
    expect(await rowOf(laptop)).toMatchObject({ late: true, quiet: true });
    expect(await pillOf(laptop)).toBe("quiet");
  });

  it("a Mac whose syncs stopped finishing and that then went silent for 10 minutes reads Late, not Sync failing", async () => {
    const { owner, member } = registry.people;
    expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { lateAfterMinutes: 3, quietAfterMinutes: 1440 })).status).toBe(200);
    const laptop = await enrolDevice(registry, owner, member, "member-late-stalled");
    await sync(laptop);
    clock.advance(6 * MINUTE);
    const pre = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-late-stalled"));
    expect(pre.status, pre.text).toBe(200);
    expect(await pillOf(laptop)).toBe("sync-failing");
    clock.advance(10 * MINUTE);
    expect(await rowOf(laptop)).toMatchObject({ late: true, quiet: false });
    expect(await pillOf(laptop)).toBe("late");
  });
});
