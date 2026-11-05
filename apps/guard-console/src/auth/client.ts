import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

import { CONSOLE_AUTH_PREFIX } from "@vibtra/console-api";

const origin = (): string => globalThis.location?.origin ?? "http://localhost";

export const authClient = createAuthClient({
  baseURL: origin(),
  basePath: CONSOLE_AUTH_PREFIX,
  plugins: [organizationClient()],
});

export type AuthUser = (typeof authClient.$Infer.Session)["user"];

export type AuthOrganization = (typeof authClient.$Infer.Organization);

export type AuthInvitation = (typeof authClient.$Infer.Invitation);
