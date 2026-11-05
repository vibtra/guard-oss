import type { OrgStore, OrgTokenRow } from "./store.js";

export const tokenHolderOf = (token: Pick<OrgTokenRow, "holder" | "createdBy">): string =>
  (token.holder ?? token.createdBy).trim().toLowerCase();

export const tokenBelongsTo = (token: Pick<OrgTokenRow, "holder" | "createdBy">, email: string): boolean =>
  tokenHolderOf(token) === email.trim().toLowerCase();

export const liveTokensHeldBy = async (
  orgs: Pick<OrgStore, "listTokens">,
  orgId: string,
  email: string,
): Promise<OrgTokenRow[]> =>
  (await orgs.listTokens(orgId)).filter(
    (token) => token.revokedAt === undefined && tokenBelongsTo(token, email),
  );

export const revokeTokensHeldBy = async (
  orgs: Pick<OrgStore, "listTokens" | "revokeToken">,
  args: { orgId: string; email: string; at: string },
): Promise<OrgTokenRow[]> => {
  const held = await liveTokensHeldBy(orgs, args.orgId, args.email);
  const revoked: OrgTokenRow[] = [];
  for (const token of held) {
    if (await orgs.revokeToken(args.orgId, token.tokenId, args.at)) {
      revoked.push({ ...token, revokedAt: args.at });
    }
  }
  return revoked;
};
