import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINUTES, startFleetBed, type FleetBed, type Laptop } from "./fleet-bed.ts";

let bed: FleetBed;

beforeAll(async () => {
  bed = await startFleetBed("guard-console-late.example");
});

afterAll(async () => {
  await bed?.close();
});

const sync = (laptop: Laptop): Promise<void> => bed.applyPolicy(laptop, "monitor");
const pillOf = async (laptop: Laptop): Promise<string> => (await bed.pillOf(laptop)).state;

describe("a Mac that stops syncing is Late on the console (VIB-52, statechart rule 8)", () => {
  it("rule 8: a Mac that missed 3 syncs of 60 s is Late, not still Monitoring, and a sync clears it", async () => {
    const laptop = await bed.enrol("member-late");
    await sync(laptop);
    expect(await pillOf(laptop)).toBe("monitoring");
    bed.clock.advance(3 * MINUTES - 1);
    expect(await pillOf(laptop)).toBe("monitoring");
    bed.clock.advance(1);
    expect(await bed.rowOf(laptop)).toMatchObject({ quiet: false, protection: { state: "late" } });
    expect(await pillOf(laptop)).toBe("late");
    await sync(laptop);
    expect(await pillOf(laptop)).toBe("monitoring");
  });

  it("the org admin can set Late to 15 minutes, and only 3 or 15", async () => {
    const { owner, admin } = bed.registry.people;
    const set = await bed.registry.consoleWrite(owner, "PUT", "/guard/settings", { lateAfterMinutes: 15 });
    expect(set.status, set.text).toBe(200);
    expect((set.body as { settings: { lateAfterMinutes: number } }).settings.lateAfterMinutes).toBe(15);
    expect((await bed.registry.consoleWrite(admin, "PUT", "/guard/settings", { lateAfterMinutes: 10 })).status).toBe(400);
    const laptop = await bed.enrol("member-late-15");
    await sync(laptop);
    bed.clock.advance(14 * MINUTES);
    expect(await pillOf(laptop)).toBe("monitoring");
    bed.clock.advance(MINUTES);
    expect(await bed.rowOf(laptop)).toMatchObject({ protection: { state: "late" } });
    expect(await pillOf(laptop)).toBe("late");
  });

  it("a Mac silent past the quiet setting shows Quiet, the deeper stage of Late", async () => {
    await bed.settings({ lateAfterMinutes: 3, quietAfterMinutes: 60 });
    const laptop = await bed.enrol("member-late-quiet");
    await sync(laptop);
    bed.clock.advance(60 * MINUTES);
    expect(await bed.rowOf(laptop)).toMatchObject({ quiet: true, protection: { state: "quiet" } });
    expect(await pillOf(laptop)).toBe("quiet");
  });

  it("a Mac whose syncs stopped finishing and that then went silent for 10 minutes reads Late, not Sync failing", async () => {
    await bed.settings({ lateAfterMinutes: 3, quietAfterMinutes: 1440 });
    const laptop = await bed.enrol("member-late-stalled");
    await sync(laptop);
    bed.clock.advance(6 * MINUTES);
    await bed.checkIn(laptop, "monitor");
    expect(await pillOf(laptop)).toBe("sync-failing");
    bed.clock.advance(10 * MINUTES);
    expect(await bed.rowOf(laptop)).toMatchObject({ quiet: false, protection: { state: "late" } });
    expect(await pillOf(laptop)).toBe("late");
  });
});
