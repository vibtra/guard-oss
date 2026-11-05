import { VibtraError } from "../errors.js";
import type { TenancyStore } from "../tenancy/store.js";
import { bearerFrom, hashDoorToken, isCliBearer, tokenKindOf } from "./tokens.js";

const refuseCliBearer = (door: string): never =>
  unauthorized(
    "This is a CLI token, not a token for this door",
    `a CLI token (vbc_…) authenticates the vibtra CLI's own doors (/v1/cli/*, /v1/workspaces/me/*) and nothing else; ${door}`,
  );

const unauthorized = (message: string, detail: string): never => {
  throw new VibtraError({ code: "DEPLOY_AUTH_EXPIRED", message, detail });
};

export interface ScimOrg {
  orgId: string;
  tokenId: string;
}

export const authenticateScimToken = async (
  tenancy: TenancyStore,
  authorization: string | undefined,
): Promise<ScimOrg> => {
  const bearer = bearerFrom(authorization);
  if (bearer === undefined) {
    return unauthorized(
      "This endpoint requires a SCIM token",
      "send Authorization: Bearer <token> — an org admin mints a SCIM token (vbs_…) for this organisation on " +
        "the Vibtra console and pastes it into the identity provider's application",
    );
  }
  if (isCliBearer(bearer)) {
    return refuseCliBearer("directory sync takes a SCIM token (vbs_…)");
  }
  const row = await tenancy.findTokenByHash(hashDoorToken(bearer));
  if (row === undefined) {
    return unauthorized("Unknown SCIM token", "the presented token matches no token on this registry");
  }
  if (tokenKindOf(row.tokenId) !== "scim") {
    return unauthorized(
      "This is a door token, not a SCIM token",
      "a door token (vbt_…) opens this registry's /v1 desktop and MCP doors; directory sync needs a SCIM " +
        "token (vbs_…), minted for this organisation on the Vibtra console",
    );
  }
  if (row.revokedAt !== undefined) {
    return unauthorized("This SCIM token was revoked", `token ${row.tokenId} was revoked at ${row.revokedAt}`);
  }
  return { orgId: row.orgId, tokenId: row.tokenId };
};
