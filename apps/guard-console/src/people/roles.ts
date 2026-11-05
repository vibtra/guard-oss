import type { ConsolePersonRow } from "@vibtra/console-api";
import type { PillTone } from "@/components/kit";

export type OrgRole = "owner" | "admin" | "member";

export const ROLES: Readonly<Record<OrgRole, { label: string; tone: PillTone; description: string }>> = {
  owner: { label: "Owner", tone: "neutral", description: "Everything an admin can do, and can change owners." },
  admin: { label: "Admin", tone: "neutral", description: "Manages rules, laptops, people and settings." },
  member: { label: "Member", tone: "muted", description: "Cannot change rules, laptops, people or settings." },
};

export const roleOf = (p: ConsolePersonRow): OrgRole => p.orgRole ?? p.role;

export const needsConfirm = (from: OrgRole, to: OrgRole): boolean => from !== to && (to === "owner" || from === "owner" || (from === "admin" && to === "member"));

export const lockedReason = (person: ConsolePersonRow, viewer: OrgRole | undefined, owners: number): string => {
  if (person.isYou === true) return "You cannot change your own role. Ask another owner.";
  if (roleOf(person) === "owner" && viewer !== "owner") return "Only an owner can change an owner’s role.";
  if (roleOf(person) === "owner" && owners <= 1) return "This is the only owner. Make someone else an owner first.";
  return "You cannot change this person’s role.";
};

const nameOf = (p: ConsolePersonRow): string => p.name ?? p.email;

export const confirmWords = (person: ConsolePersonRow, from: OrgRole, to: OrgRole): { title: string; body: string; label: string } => {
  const name = nameOf(person);
  if (to === "owner")
    return {
      title: `Make ${name} an owner?`,
      body: "Owners can do everything, including changing other owners. Only an owner can take this back.",
      label: "Make owner",
    };
  if (from === "owner")
    return {
      title: `Change ${name} from owner to ${ROLES[to].label.toLowerCase()}?`,
      body:
        to === "admin"
          ? "They keep managing rules, laptops, people and settings, but can no longer change owners."
          : "They can no longer change rules, laptops, people or settings.",
      label: `Make ${ROLES[to].label.toLowerCase()}`,
    };
  return {
    title: `Make ${name} a member?`,
    body: "They can no longer change rules, laptops, people or settings.",
    label: "Make member",
  };
};

export const changedWords = (person: ConsolePersonRow, to: OrgRole): string => `${nameOf(person)} is now ${to === "admin" || to === "owner" ? "an" : "a"} ${ROLES[to].label.toLowerCase()}.`;
