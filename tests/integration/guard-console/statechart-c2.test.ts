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

const NOW = Date.now();
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();
const synced: Row = { status: "active", quiet: false, clientMode: "enforce", health: { interception: { on: true } }, lastSeenAt: ago(0), lastPostflightAt: ago(0), bundleVersion: 3 };

describe("the console pill only says Protected or Monitoring for a Mac that applied a policy", () => {
  it("a synced Mac is Protected or Monitoring, revoked is Revoked, interception off is Not protected", () => {
    expect(deviceState(synced).key).toBe("protected");
    expect(deviceState({ ...synced, clientMode: "monitor" }).key).toBe("monitoring");
    expect(deviceState({ ...synced, status: "revoked" }).key).toBe("revoked");
    expect(deviceState({ ...synced, health: { interception: { on: false, reason: "no-secure-enclave" } } }).key).toBe("unprotected");
  });

  it("a Mac between the preflight and the postflight of a sync stays Protected", () => {
    expect(deviceState({ ...synced, lastSeenAt: ago(0), lastPostflightAt: ago(61) }).key).toBe("protected");
  });

  it("a Mac whose preflight reached the console but which never applied a policy is not Protected or Monitoring", () => {
    const row: Row = { ...synced, bundleVersion: undefined, lastPostflightAt: undefined };
    expect(deviceState(row).key).not.toBe("protected");
    expect(deviceState({ ...row, clientMode: "monitor" }).key).not.toBe("monitoring");
  });

  it("a Mac whose syncs keep failing after the preflight is not Protected or Monitoring", () => {
    const row: Row = { ...synced, lastSeenAt: ago(0), lastPostflightAt: ago(10 * 60) };
    expect(deviceState(row).key).not.toBe("protected");
    expect(deviceState({ ...row, clientMode: "monitor" }).key).not.toBe("monitoring");
  });

  it("a new row that has never synced is not Protected", () => {
    const row: Row = { status: "active", quiet: false, clientMode: "enforce", health: undefined, lastSeenAt: undefined, lastPostflightAt: undefined, bundleVersion: undefined };
    expect(deviceState(row).key).not.toBe("protected");
  });
});
