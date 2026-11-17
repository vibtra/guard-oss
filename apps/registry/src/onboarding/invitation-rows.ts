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
});
export type InvitationRow = z.infer<typeof InvitationRow>;

const LIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "accepted"]);

export const liveInvitation = async (adapter: AuthDbAdapter, invitationId: string): Promise<InvitationRow | undefined> => {
  const parsed = InvitationRow.safeParse(await adapter.findOne<unknown>({ model: "invitation", where: [{ field: "id", value: invitationId }] }));
  return parsed.success && LIVE_STATUSES.has(parsed.data.status) ? parsed.data : undefined;
};
