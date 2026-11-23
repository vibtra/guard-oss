import {
  ConsoleGroupDetail,
  ConsoleGroupsPage,
  ConsoleInvitationCreated,
  ConsolePeoplePage,
  ConsoleRegistrationPage,
  OnboardingPage,
  OnboardingReminder,
  OnboardingSettingsPage,
  type ChaseAfterDays,
  type ConsoleInviteRole,
} from "@vibtra/console-api";
import { GuardProtectionApplied, GuardProtectionPage, GuardProtectionPreview, GuardProtectionRollout, type GuardProtectionChange } from "@vibtra/guard-contract";
import { call, send, write } from "../api/client";

const id = (value: string): string => encodeURIComponent(value);

export const groupsDoor = {
  list: () => call(ConsoleGroupsPage, "/groups"),
  create: (name: string) => write(ConsoleGroupDetail, "/groups", { name }),
  addMember: (groupId: string, email: string) => write(ConsoleGroupDetail, `/groups/${id(groupId)}/members`, { email }),
  removeMember: (groupId: string, email: string) => send(ConsoleGroupDetail, "DELETE", `/groups/${id(groupId)}/members/${id(email)}`),
};

export const peopleDoor = {
  setRole: (userId: string, role: "owner" | "admin" | "member") => write(ConsolePeoplePage, `/people/${id(userId)}/role`, { role }),
  remove: (userId: string) => send(ConsolePeoplePage, "DELETE", `/people/${id(userId)}`),
  invite: (email: string, role: ConsoleInviteRole) => write(ConsoleInvitationCreated, "/people/invitations", { email, role }),
};

export const protectionDoor = {
  page: () => call(GuardProtectionPage, "/people/protection"),
  preview: (changes: GuardProtectionChange[]) => write(GuardProtectionPreview, "/people/protection/preview", { changes }),
  apply: (changes: GuardProtectionChange[], revision: number, peopleDigest: string) => write(GuardProtectionApplied, "/people/protection/apply", { changes, revision, peopleDigest }),
  rollout: (revision: number) => call(GuardProtectionRollout, `/people/protection/rollout?revision=${revision}`),
};

export const onboardingDoor = {
  page: () => call(OnboardingPage, "/people/onboarding"),
  resend: (invitationId: string) => write(ConsoleInvitationCreated, `/people/invitations/${id(invitationId)}/resend`, {}),
  remind: (userId: string) => write(OnboardingReminder, `/people/${id(userId)}/onboarding/remind`, {}),
  settings: () => call(OnboardingSettingsPage, "/people/onboarding/settings"),
  setChaseAfterDays: (chaseAfterDays: ChaseAfterDays) => send(OnboardingSettingsPage, "PUT", "/people/onboarding/settings", { chaseAfterDays }),
};

export const registrationDoor = {
  read: () => call(ConsoleRegistrationPage, "/registration"),
  add: (subject: string, note?: string) => write(ConsoleRegistrationPage, "/registration/allowlist", note === undefined || note === "" ? { subject } : { subject, note }),
  remove: (rowId: string) => send(ConsoleRegistrationPage, "DELETE", `/registration/allowlist/${id(rowId)}`),
  admit: (orgId: string) => write(ConsoleRegistrationPage, `/registration/waitlist/${id(orgId)}/admit`, {}),
};
