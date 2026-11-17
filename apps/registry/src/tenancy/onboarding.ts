import type { OrgRole } from "../auth/session.js";
import type { GuardDeviceRecord, GuardStore } from "../guard/store.js";
import type { MemberDirectory, OrgInvitationRow, OrgMemberRow } from "./members.js";

interface OnboardingDeviceFacts {
  deviceId: string;
  enrolledAt: string;
  caTrustedAt?: string;
  extensionApprovedAt?: string;
  lastSyncAt?: string;
  integrityFailedAt?: string;
}

interface OnboardingPersonFacts {
  userId: string;
  email: string;
  name?: string;
  role: OrgRole;
  joinedAt: string;
  invitedAt?: string;
  firstSignInAt?: string;
  devices: OnboardingDeviceFacts[];
}

interface OnboardingInviteFacts {
  invitationId: string;
  email: string;
  role: OrgRole;
  invitedAt: string;
  expiresAt: string;
  lastSentAt?: string;
}

interface OnboardingFacts {
  people: OnboardingPersonFacts[];
  invites: OnboardingInviteFacts[];
}

export interface OnboardingStore {
  listOnboardingFacts(orgId: string): Promise<OnboardingFacts>;
  recordInviteSent(input: { orgId: string; invitationId: string; at: string }): Promise<boolean>;
}

const deviceFacts = (device: GuardDeviceRecord): OnboardingDeviceFacts => ({
  deviceId: device.deviceId,
  enrolledAt: device.enrolledAt,
  ...(device.caTrustedAt === undefined ? {} : { caTrustedAt: device.caTrustedAt }),
  ...(device.extensionApprovedAt === undefined ? {} : { extensionApprovedAt: device.extensionApprovedAt }),
  ...(device.lastSeenAt === undefined ? {} : { lastSyncAt: device.lastSeenAt }),
  ...(device.integrityFailedAt === undefined ? {} : { integrityFailedAt: device.integrityFailedAt }),
});

const firstInviteByEmail = (invitations: readonly OrgInvitationRow[]): Map<string, string> => {
  const first = new Map<string, string>();
  for (const invitation of invitations) {
    if (invitation.status !== "accepted") continue;
    const known = first.get(invitation.email);
    if (known === undefined || invitation.invitedAt < known) first.set(invitation.email, invitation.invitedAt);
  }
  return first;
};

const onboardingFactsOf = ({
  members,
  invitations,
  devices,
}: {
  members: readonly OrgMemberRow[];
  invitations: readonly OrgInvitationRow[];
  devices: readonly GuardDeviceRecord[];
}): OnboardingFacts => {
  const invitedAt = firstInviteByEmail(invitations);
  const enrolled = devices.filter((device) => device.status === "active");
  return {
    people: members.map((member) => {
      const invited = invitedAt.get(member.email.trim().toLowerCase());
      return {
        userId: member.userId,
        email: member.email,
        ...(member.name === null ? {} : { name: member.name }),
        role: member.role,
        joinedAt: member.createdAt,
        ...(invited === undefined ? {} : { invitedAt: invited }),
        ...(member.firstSignInAt === undefined ? {} : { firstSignInAt: member.firstSignInAt }),
        devices: enrolled.filter((device) => device.personUserId === member.userId).map(deviceFacts),
      };
    }),
    invites: invitations
      .filter((invitation) => invitation.status === "pending")
      .map((invitation) => ({
        invitationId: invitation.invitationId,
        email: invitation.email,
        role: invitation.role,
        invitedAt: invitation.invitedAt,
        expiresAt: invitation.expiresAt,
        ...(invitation.lastSentAt === undefined ? {} : { lastSentAt: invitation.lastSentAt }),
      })),
  };
};

export const createOnboardingStore = ({
  members,
  guard,
}: {
  members: Pick<MemberDirectory, "listMembers" | "listInvitations" | "recordInviteSent">;
  guard: Pick<GuardStore, "listDevices">;
}): OnboardingStore => ({
  async listOnboardingFacts(orgId) {
    const [memberRows, invitations, devices] = await Promise.all([members.listMembers(orgId), members.listInvitations(orgId), guard.listDevices(orgId)]);
    return onboardingFactsOf({ members: memberRows, invitations, devices });
  },
  recordInviteSent: (input) => members.recordInviteSent(input),
});
