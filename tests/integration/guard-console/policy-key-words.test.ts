import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuardDeviceRow } from "@vibtra/guard-contract";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Fleet = { policyKeyWords: (row: Pick<GuardDeviceRow, "health">) => string };

let fleet: ConsoleModule<Fleet>;

beforeAll(async () => {
  fleet = await loadConsoleModule<Fleet>("/src/people/fleet.tsx");
});

afterAll(async () => {
  await fleet?.close();
});

describe("the Devices sheet says where a Mac's policy-signing key came from", () => {
  it("names the store and source of a pinned key, each problem, and an agent that does not say", () => {
    const words = (policyKey?: NonNullable<GuardDeviceRow["health"]>["policyKey"]) => fleet.module.policyKeyWords({ health: policyKey === undefined ? {} : { policyKey } });
    expect(words()).toBe("Not reported");
    expect(words({ store: "keychain", pinned: "enrolment" })).toBe("Pinned in the keychain, at enrolment");
    expect(words({ store: "keychain", pinned: "registry" })).toBe("Pinned in the keychain, fetched from this server");
    expect(words({ store: "unprotected", pinned: "enrolment" })).toBe("Pinned in a file the person can change, at enrolment");
    expect(words({ store: "keychain", reason: "policy-key-fetching" })).toBe("None yet: fetching it from this server");
    expect(words({ store: "keychain", pinned: "enrolment", reason: "policy-key-mismatch" })).toContain("enrol again");
    expect(words({ store: "keychain", reason: "policy-key-untrusted-source" })).toContain("Enrol again");
    expect(words({ store: "keychain", reason: "policy-key-unavailable" })).toBe("Unreadable on this Mac");
  });
});
