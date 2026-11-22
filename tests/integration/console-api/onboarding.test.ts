import { describe, expect, it } from "vitest";
import {
  ChaseAfterDays,
  DEFAULT_CHASE_AFTER_DAYS,
  ONBOARDING_STAGES,
  OnboardingPage,
  OnboardingRow,
  OnboardingSettings,
  isBannedFieldName,
} from "@vibtra/console-api";

const person = {
  kind: "person",
  userId: "user_ada",
  email: "ada@acme.example",
  name: "Ada",
  role: "member",
  stage: "enrolled",
  stageSince: "2026-11-10T09:00:00.000Z",
  chase: false,
} as const;

const invite = {
  kind: "invite",
  invitationId: "inv_bea",
  email: "bea@acme.example",
  role: "admin",
  stage: "invited",
  stageSince: "2026-11-01T09:00:00.000Z",
  chase: true,
  lastSentAt: "2026-11-03T09:00:00.000Z",
  expiresAt: "2026-11-08T09:00:00.000Z",
} as const;

const fieldNames = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(fieldNames);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...fieldNames(inner)]);
};

describe("OnboardingStage", () => {
  it("lists the funnel in the order a person moves through it", () => {
    expect(ONBOARDING_STAGES).toEqual(["invited", "signed_in", "enrolled", "certificate_trusted", "protected", "late", "tampered", "not_in_scope"]);
  });
});

describe("OnboardingRow", () => {
  it("parses a person and a pending invite on one page", () => {
    const page = OnboardingPage.parse({ rows: [person, invite], chaseAfterDays: 7 });
    expect(page.rows.map((row) => row.kind)).toEqual(["person", "invite"]);
  });

  it("accepts an invite for any org role, the roles the store reads back", () => {
    for (const role of ["owner", "admin", "member"]) expect(OnboardingRow.safeParse({ ...invite, role }).success).toBe(true);
  });

  it("refuses a pending invite with no expiry", () => {
    const { expiresAt: _expiresAt, ...noExpiry } = invite;
    expect(OnboardingRow.safeParse(noExpiry).success).toBe(false);
  });

  it("refuses a pending invite that claims a later stage than invited", () => {
    expect(OnboardingRow.safeParse({ ...invite, stage: "enrolled" }).success).toBe(false);
  });

  it("refuses a stage outside the funnel", () => {
    expect(OnboardingRow.safeParse({ ...person, stage: "onboarded" }).success).toBe(false);
  });

  it("refuses a stageSince that is not an ISO time", () => {
    expect(OnboardingRow.safeParse({ ...person, stageSince: "last week" }).success).toBe(false);
  });

  it("refuses a row with no chase flag", () => {
    const { chase: _chase, ...noChase } = person;
    expect(OnboardingRow.safeParse(noChase).success).toBe(false);
  });

  it("refuses a field the contract does not name", () => {
    expect(OnboardingRow.safeParse({ ...invite, inviteUrl: "https://acme.example/i/1" }).success).toBe(false);
  });

  it("carries no field name the console wire bans", () => {
    expect(fieldNames(OnboardingPage.parse({ rows: [person, invite], chaseAfterDays: 7 })).filter(isBannedFieldName)).toEqual([]);
  });
});

describe("chaseAfterDays", () => {
  it("defaults to seven days", () => {
    expect(DEFAULT_CHASE_AFTER_DAYS).toBe(7);
  });

  it("accepts whole days from one to a year", () => {
    expect(OnboardingSettings.parse({ chaseAfterDays: 1 }).chaseAfterDays).toBe(1);
    expect(OnboardingSettings.parse({ chaseAfterDays: 365 }).chaseAfterDays).toBe(365);
  });

  it("refuses zero, fractions and more than a year", () => {
    for (const days of [0, 2.5, 366]) expect(ChaseAfterDays.safeParse(days).success).toBe(false);
  });
});
