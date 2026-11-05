import type { organization } from "better-auth/plugins/organization";
import { AUTH_BASE_PATH } from "./fastify.js";

export const registryTeamOptions = {
  teams: { enabled: true, allowRemovingAllTeams: true },
  schema: {
    team: {
      additionalFields: {
        createdBy: { type: "string", required: false, input: false },
      },
    },
  },
  organizationHooks: {
    beforeCreateTeam: async ({
      team,
      user,
    }: {
      team: Record<string, unknown>;
      user?: { email?: string } & Record<string, unknown>;
    }) => ({ data: { ...team, createdBy: typeof user?.email === "string" ? user.email : "" } }),
  },
} satisfies Parameters<typeof organization>[0];

export const TEAM_ENDPOINT_PATHS: readonly string[] = [
  "/organization/create-team",
  "/organization/update-team",
  "/organization/remove-team",
  "/organization/list-teams",
  "/organization/list-user-teams",
  "/organization/set-active-team",
  "/organization/add-team-member",
  "/organization/remove-team-member",
  "/organization/list-team-members",
];

export const teamsConsoleOnly = () => ({
  id: "vibtra-teams-console-only",
  onRequest: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (!TEAM_ENDPOINT_PATHS.some((p) => path === `${AUTH_BASE_PATH}${p}`)) return;
    return {
      response: new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    };
  },
});
