import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuardPreflightRequest } from "@vibtra/guard-contract";
import { MINUTES, startFleetBed, type FleetBed } from "./fleet-bed.ts";

let bed: FleetBed;

beforeAll(async () => {
  bed = await startFleetBed("guard-console-c3.example");
  await bed.settings({ quietAfterMinutes: 5 });
});

afterAll(async () => {
  await bed?.close();
});

const off: NonNullable<GuardPreflightRequest["health"]> = { interception: { on: false, reason: "no-secure-enclave" }, extensionActive: true };

describe("the console pill (DevicePill on the registry's row)", () => {
  it("a synced enforcing Mac is Protected, a monitoring Mac is Monitoring, a Mac with interception off is Not protected, a revoked Mac is Revoked", async () => {
    expect((await bed.pillOf(await bed.synced("c3-synced"))).state).toBe("protected");
    expect((await bed.pillOf(await bed.synced("c3-monitor", "monitor"))).state).toBe("monitoring");
    expect((await bed.pillOf(await bed.synced("c3-off", "enforce", off))).state).toBe("unprotected");
    const revoked = await bed.synced("c3-revoked", "enforce", off);
    bed.clock.advance(5 * MINUTES);
    expect(await bed.rowOf(revoked)).toMatchObject({ quiet: true, protection: { state: "unprotected", reason: "no-secure-enclave" } });
    await bed.revoke(revoked);
    expect((await bed.pillOf(revoked)).state).toBe("revoked");
  });

  it("a quiet Mac whose last sync said interception is off still shows Not protected", async () => {
    const laptop = await bed.synced("c3-quiet-off", "enforce", off);
    bed.clock.advance(5 * MINUTES);
    expect(await bed.rowOf(laptop)).toMatchObject({ quiet: true });
    expect(await bed.pillOf(laptop)).toMatchObject({ state: "unprotected", label: "Not protected" });
  });

  it("a quiet Mac whose last sync said interception is on shows Quiet", async () => {
    const laptop = await bed.synced("c3-quiet-on");
    bed.clock.advance(5 * MINUTES);
    expect(await bed.rowOf(laptop)).toMatchObject({ quiet: true });
    expect(await bed.pillOf(laptop)).toMatchObject({ state: "quiet", label: "Quiet" });
  });
});
