import {
  ConsoleGroupDetail,
  ConsoleGroupsPage,
  ConsoleInvitationCreated,
  ConsolePeoplePage,
  ConsoleRegistrationPage,
  type ConsoleInviteRole,
} from "@vibtra/console-api";
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

export const invitationLink = (invitationId: string, origin: string = globalThis.location?.origin ?? ""): string =>
  `${origin}/login?invitation=${encodeURIComponent(invitationId)}`;

export const registrationDoor = {
  read: () => call(ConsoleRegistrationPage, "/registration"),
  add: (subject: string, note?: string) => write(ConsoleRegistrationPage, "/registration/allowlist", note === undefined || note === "" ? { subject } : { subject, note }),
  remove: (rowId: string) => send(ConsoleRegistrationPage, "DELETE", `/registration/allowlist/${id(rowId)}`),
  admit: (orgId: string) => write(ConsoleRegistrationPage, `/registration/waitlist/${id(orgId)}/admit`, {}),
};
