import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINUTES, SECONDS, startFleetBed, type FleetBed } from "./fleet-bed.ts";

let bed: FleetBed;

beforeAll(async () => {
  bed = await startFleetBed("guard-console-c2.example");
});

afterAll(async () => {
  await bed?.close();
});

describe("the console pill only says Protected or Monitoring for a Mac that applied a policy", () => {
  it("a synced Mac is Protected or Monitoring, revoked is Revoked, interception off is Not protected", async () => {
    expect(await bed.pillOf(await bed.synced("c2-synced"))).toEqual({ state: "protected", tone: "ok", label: "Protected" });
    expect((await bed.pillOf(await bed.synced("c2-monitor", "monitor"))).state).toBe("monitoring");
    const revoked = await bed.synced("c2-revoked");
    await bed.revoke(revoked);
    expect((await bed.pillOf(revoked)).state).toBe("revoked");
    expect((await bed.pillOf(await bed.synced("c2-off", "enforce", { interception: { on: false, reason: "no-secure-enclave" } }))).state).toBe("unprotected");
  });

  it("a Mac between the preflight and the postflight of a sync stays Protected for up to 5 minutes", async () => {
    const laptop = await bed.synced("c2-between");
    bed.clock.advance(61 * SECONDS);
    await bed.checkIn(laptop, "enforce");
    expect((await bed.pillOf(laptop)).state).toBe("protected");
    bed.clock.advance(5 * MINUTES - 61 * SECONDS);
    await bed.checkIn(laptop, "enforce");
    expect((await bed.pillOf(laptop)).state).toBe("protected");
    bed.clock.advance(1 * SECONDS);
    await bed.checkIn(laptop, "enforce");
    expect((await bed.pillOf(laptop)).state).toBe("sync-failing");
  });

  it("a Mac whose preflight reached the console but which never applied a policy is not Protected or Monitoring", async () => {
    for (const clientMode of ["enforce", "monitor"] as const) {
      const laptop = await bed.enrol(`c2-no-policy-${clientMode}`);
      await bed.checkIn(laptop, clientMode, { interception: { on: true }, extensionActive: true });
      expect(await bed.rowOf(laptop)).toMatchObject({ clientMode, protection: { state: "no-policy" } });
      expect(await bed.pillOf(laptop)).toMatchObject({ state: "no-policy", label: "No policy yet" });
    }
  });

  it("a Mac whose syncs keep failing after the preflight is not Protected or Monitoring", async () => {
    const laptops = [await bed.synced("c2-failing-enforce"), await bed.synced("c2-failing-monitor", "monitor")];
    bed.clock.advance(10 * MINUTES);
    for (const [laptop, clientMode] of [[laptops[0], "enforce"], [laptops[1], "monitor"]] as const) {
      if (laptop === undefined) throw new Error("expected two laptops");
      await bed.checkIn(laptop, clientMode);
      expect(await bed.rowOf(laptop)).toMatchObject({ clientMode, protection: { state: "sync-failing" } });
      expect(await bed.pillOf(laptop)).toMatchObject({ state: "sync-failing", label: "Sync failing" });
    }
  });

  it("a new row that has never synced is not Protected", async () => {
    const laptop = await bed.enrol("c2-new");
    const row = await bed.rowOf(laptop);
    expect(row).toMatchObject({ status: "active", quiet: false, protection: { state: "no-policy" } });
    expect(row.health).toBeUndefined();
    expect(row.lastPostflightAt).toBeUndefined();
    expect(await bed.pillOf(laptop)).toMatchObject({ state: "no-policy", label: "No policy yet" });
  });

  it("a synced Enforce Mac without proof of its checks is Not protected, naming the missing proof (VIB-110)", async () => {
    const unreported = await bed.synced("c2-unreported", "enforce", { extensionActive: true });
    expect((await bed.rowOf(unreported)).protection).toEqual({ state: "unprotected", reason: "interception-not-reported" });
    expect(await bed.pillOf(unreported)).toEqual({ state: "unprotected", tone: "bad", label: "Not protected" });
    const noExtension = await bed.synced("c2-no-extension", "enforce", { interception: { on: true }, extensionActive: false });
    expect((await bed.rowOf(noExtension)).protection).toEqual({ state: "unprotected", reason: "extension-not-active" });
    const monitor = await bed.synced("c2-unreported-monitor", "monitor", {});
    expect((await bed.pillOf(monitor)).state).toBe("monitoring");
  });
});
