import type { OrgRole } from "../auth/session.js";
import type { GuardDeviceRecord, GuardStore } from "../guard/store.js";
import type { MemberDirectory, OrgInvitationRow, OrgMemberRow } from "./members.js";

interface OnboardingDeviceFacts {
  deviceId: string;
  enrolledAt: string;
  caTrusted: boolean;
  extensionActive: boolean;
  caTrustedAt?: string;
  extensionApprovedAt?: string;
  lastSyncAt?: string;
  integrityFailedAt?: string;
  integrityCheckedAt?: string;
}

interface OnboardingPersonFacts {
  userId: string;
  email: string;
  name?: string;
  role: OrgRole;
  joinedAt: string;
  invitedAt?: string;
  firstSignInAt: string | null;
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
  caTrusted: device.health?.caTrusted === true,
  extensionActive: device.health?.extensionActive === true,
  ...(device.caTrustedAt === undefined ? {} : { caTrustedAt: device.caTrustedAt }),
  ...(device.extensionApprovedAt === undefined ? {} : { extensionApprovedAt: device.extensionApprovedAt }),
  ...(device.lastSeenAt === undefined ? {} : { lastSyncAt: device.lastSeenAt }),
  ...(device.integrityFailedAt === undefined ? {} : { integrityFailedAt: device.integrityFailedAt }),
  ...(device.integrityCheckedAt === undefined ? {} : { integrityCheckedAt: device.integrityCheckedAt }),
});

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
};

const invitedAtOf = (accepted: readonly OrgInvitationRow[], joinedAt: string): string | undefined =>
  accepted
    .filter((invitation) => Date.parse(invitation.invitedAt) <= Date.parse(joinedAt))
    .reduce<string | undefined>((latest, invitation) => (latest === undefined || Date.parse(invitation.invitedAt) > Date.parse(latest) ? invitation.invitedAt : latest), undefined);

const onboardingFactsOf = ({
  members,
  invitations,
  devices,
}: {
  members: readonly OrgMemberRow[];
  invitations: readonly OrgInvitationRow[];
  devices: readonly GuardDeviceRecord[];
}): OnboardingFacts => {
  const acceptedByEmail = groupBy(
    invitations.filter((invitation) => invitation.status === "accepted"),
    (invitation) => invitation.email,
  );
  const devicesByPerson = groupBy(
    devices.filter((device) => device.status === "active"),
    (device) => device.personUserId,
  );
  return {
    people: members.map((member) => {
      const invited = invitedAtOf(acceptedByEmail.get(member.email.trim().toLowerCase()) ?? [], member.createdAt);
      return {
        userId: member.userId,
        email: member.email,
        ...(member.name === null ? {} : { name: member.name }),
        role: member.role,
        joinedAt: member.createdAt,
        ...(invited === undefined ? {} : { invitedAt: invited }),
        firstSignInAt: member.firstSignInAt,
        devices: (devicesByPerson.get(member.userId) ?? []).map(deviceFacts),
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
