import { z } from "zod";

export const CONSOLE_GROUP_NAME_MAX = 64;

export const ConsoleGroupMember = z.object({
  email: z.string().min(1),
  name: z.string().min(1).nullable(),
});
export type ConsoleGroupMember = z.infer<typeof ConsoleGroupMember>;

const ConsoleGroupUsage = z.object({
  tools: z.number().int().min(0),
  connections: z.number().int().min(0),
});

export const ConsoleGroupRow = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  members: z.array(ConsoleGroupMember).optional(),
  memberCount: z.number().int().min(0),
  usedBy: ConsoleGroupUsage,
  createdAt: z.string().min(1),
  createdBy: z.string().min(1).optional(),
});
export type ConsoleGroupRow = z.infer<typeof ConsoleGroupRow>;

export const ConsoleGroupsPage = z.object({ rows: z.array(ConsoleGroupRow) });
export type ConsoleGroupsPage = z.infer<typeof ConsoleGroupsPage>;

export const ConsoleGroupDetail = z.object({ row: ConsoleGroupRow });
export type ConsoleGroupDetail = z.infer<typeof ConsoleGroupDetail>;

export const ConsoleGroupNameRequest = z.object({
  name: z.string().min(1).max(CONSOLE_GROUP_NAME_MAX),
});
export type ConsoleGroupNameRequest = z.infer<typeof ConsoleGroupNameRequest>;

export const ConsoleGroupMemberRequest = z.object({
  email: z.string().min(1).max(320),
});
export type ConsoleGroupMemberRequest = z.infer<typeof ConsoleGroupMemberRequest>;

export const ConsoleGroupInUse = z.object({
  message: z.string().min(1),
  usedBy: z.object({
    tools: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
    connections: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  }),
  code: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
});
export type ConsoleGroupInUse = z.infer<typeof ConsoleGroupInUse>;

const ConsoleMyGroup = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const ConsoleMyGroupsPage = z.object({ rows: z.array(ConsoleMyGroup) });
export type ConsoleMyGroupsPage = z.infer<typeof ConsoleMyGroupsPage>;

export const MY_GROUPS_RESPONSE_SCHEMAS = {
  "GET /me/groups": ConsoleMyGroupsPage,
} as const;
