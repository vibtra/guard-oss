import { z } from "zod";
import type { AuthDbAdapter } from "../tenancy/members.js";

export const When = z.union([z.date(), z.string().min(1)]).transform((value) => new Date(value).toISOString());

const InvitationRow = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  email: z.string().min(1).transform((email) => email.trim().toLowerCase()),
  role: z.string().nullish(),
  status: z.string(),
  expiresAt: When,
  createdAt: When.nullish(),
  lastSentAt: When.nullish(),
});
export type InvitationRow = z.infer<typeof InvitationRow>;

const MemberRow = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  createdAt: When,
  lastRemindedAt: When.nullish(),
});

const UserRow = z.object({ email: z.string().min(1).transform((email) => email.trim().toLowerCase()) });

export interface OnboardingMember {
  memberId: string;
  orgId: string;
  userId: string;
  email: string;
  linkGeneration: string;
}

export const invitationLinkGeneration = (row: InvitationRow): string | undefined => row.lastSentAt ?? row.createdAt ?? undefined;

const LIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "accepted"]);

const invitationRow = async (adapter: AuthDbAdapter, where: Array<{ field: string; value: string }>): Promise<InvitationRow | undefined> => {
  const parsed = InvitationRow.safeParse(await adapter.findOne<unknown>({ model: "invitation", where }));
  return parsed.success ? parsed.data : undefined;
};

export const liveInvitation = async (adapter: AuthDbAdapter, invitationId: string): Promise<InvitationRow | undefined> => {
  const row = await invitationRow(adapter, [{ field: "id", value: invitationId }]);
  return row !== undefined && LIVE_STATUSES.has(row.status) ? row : undefined;
};

export const pendingInvitation = async (adapter: AuthDbAdapter, orgId: string, invitationId: string): Promise<InvitationRow | undefined> => {
  const row = await invitationRow(adapter, [
    { field: "id", value: invitationId },
    { field: "organizationId", value: orgId },
  ]);
  return row?.status === "pending" ? row : undefined;
};

const memberOf = async (adapter: AuthDbAdapter, where: Array<{ field: string; value: string }>): Promise<OnboardingMember | undefined> => {
  const member = MemberRow.safeParse(await adapter.findOne<unknown>({ model: "member", where }));
  if (!member.success) return undefined;
  const user = UserRow.safeParse(await adapter.findOne<unknown>({ model: "user", where: [{ field: "id", value: member.data.userId }] }));
  if (!user.success) return undefined;
  return {
    memberId: member.data.id,
    orgId: member.data.organizationId,
    userId: member.data.userId,
    email: user.data.email,
    linkGeneration: member.data.lastRemindedAt ?? member.data.createdAt,
  };
};

export const onboardingMemberById = (adapter: AuthDbAdapter, memberId: string): Promise<OnboardingMember | undefined> =>
  memberOf(adapter, [{ field: "id", value: memberId }]);

export const onboardingMemberOf = (adapter: AuthDbAdapter, orgId: string, userId: string): Promise<OnboardingMember | undefined> =>
  memberOf(adapter, [
    { field: "organizationId", value: orgId },
    { field: "userId", value: userId },
  ]);

const SSO_PROVIDER_PREFIX = "sso-";

const AccountRow = z.object({ providerId: z.string().min(1) });

export const hasSsoIdentity = async (adapter: AuthDbAdapter, userId: string, orgId: string): Promise<boolean> => {
  const accounts = await adapter.findMany<unknown>({ model: "account", where: [{ field: "userId", value: userId }] });
  const providers = accounts.flatMap((row) => {
    const parsed = AccountRow.safeParse(row);
    return parsed.success && parsed.data.providerId.startsWith(SSO_PROVIDER_PREFIX) ? [parsed.data.providerId] : [];
  });
  for (const providerId of providers) {
    const provider = await adapter.findOne<unknown>({
      model: "ssoProvider",
      where: [
        { field: "providerId", value: providerId },
        { field: "organizationId", value: orgId },
      ],
    });
    if (provider !== null) return true;
  }
  return false;
};
