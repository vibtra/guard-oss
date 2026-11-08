import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuardDeviceRow } from "@vibtra/guard-contract";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Row = Pick<GuardDeviceRow, "status" | "quiet" | "clientMode" | "health" | "lastSeenAt" | "lastPostflightAt" | "bundleVersion">;
type Fleet = { deviceState: (row: Row) => { key: string; label: string } };

let fleet: ConsoleModule<Fleet>;
let deviceState: Fleet["deviceState"];

beforeAll(async () => {
  fleet = await loadConsoleModule<Fleet>("/src/people/fleet.tsx");
  ({ deviceState } = fleet.module);
});

afterAll(async () => {
  await fleet?.close();
});

const now = new Date().toISOString();
const synced: Row = { status: "active", quiet: false, clientMode: "enforce", health: { interception: { on: true } }, lastSeenAt: now, lastPostflightAt: now, bundleVersion: 3 };
const off: Row["health"] = { interception: { on: false, reason: "no-secure-enclave" } };

describe("the console pill (deviceState)", () => {
  it("a synced enforcing Mac is Protected, a monitoring Mac is Monitoring, a Mac with interception off is Not protected, a revoked Mac is Revoked", () => {
    expect(deviceState(synced).key).toBe("protected");
    expect(deviceState({ ...synced, clientMode: "monitor" }).key).toBe("monitoring");
    expect(deviceState({ ...synced, health: off }).key).toBe("unprotected");
    expect(deviceState({ ...synced, status: "revoked", quiet: true, health: off }).key).toBe("revoked");
  });

  it("a quiet Mac whose last sync said interception is off still shows Not protected", () => {
    expect(deviceState({ ...synced, quiet: true, health: off })).toMatchObject({ key: "unprotected", label: "Not protected" });
  });

  it("a quiet Mac whose last sync said interception is on shows Quiet", () => {
    expect(deviceState({ ...synced, quiet: true })).toMatchObject({ key: "quiet", label: "Quiet" });
  });
});
