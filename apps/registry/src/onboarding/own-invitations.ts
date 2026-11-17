import { z } from "zod";
import type { AuthDbAdapter } from "../tenancy/members.js";
import { When } from "./invitation-rows.js";

const PendingRow = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  email: z.string().min(1).transform((email) => email.trim().toLowerCase()),
  status: z.literal("pending"),
  expiresAt: When,
  inviterId: z.string().min(1).nullish(),
});

const InviterRow = z.object({ name: z.string().nullish(), email: z.string().min(1) });

export interface OwnInvitation {
  invitationId: string;
  orgName: string;
  invitedBy: string;
  expiresAt: string;
}

export interface OwnInvitationSources {
  adapter: AuthDbAdapter;
  org(orgId: string): Promise<{ name: string; closedAt?: string } | undefined>;
  now(): Date;
}

const SOMEBODY = "An admin";

const inviterOf = async (adapter: AuthDbAdapter, inviterId: string | null | undefined): Promise<string> => {
  if (inviterId === null || inviterId === undefined) return SOMEBODY;
  const parsed = InviterRow.safeParse(await adapter.findOne<unknown>({ model: "user", where: [{ field: "id", value: inviterId }] }));
  if (!parsed.success) return SOMEBODY;
  const name = parsed.data.name?.trim() ?? "";
  return name === "" ? parsed.data.email : name;
};

export const ownInvitations = async (sources: OwnInvitationSources, email: string): Promise<OwnInvitation[]> => {
  const wanted = email.trim().toLowerCase();
  const rows = await sources.adapter.findMany<unknown>({
    model: "invitation",
    where: [
      { field: "email", value: wanted },
      { field: "status", value: "pending" },
    ],
  });
  const now = sources.now().getTime();
  const live = rows.flatMap((row) => {
    const parsed = PendingRow.safeParse(row);
    return parsed.success && parsed.data.email === wanted && Date.parse(parsed.data.expiresAt) > now ? [parsed.data] : [];
  });
  const offered = await Promise.all(
    live.map(async (row): Promise<OwnInvitation | undefined> => {
      const org = await sources.org(row.organizationId);
      if (org === undefined || org.closedAt !== undefined) return undefined;
      return { invitationId: row.id, orgName: org.name, invitedBy: await inviterOf(sources.adapter, row.inviterId), expiresAt: row.expiresAt };
    }),
  );
  return offered.filter((row): row is OwnInvitation => row !== undefined).sort((a, b) => a.orgName.localeCompare(b.orgName));
};
