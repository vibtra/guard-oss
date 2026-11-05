import crypto from "node:crypto";

export const DOOR_TOKEN_PREFIX = "vbt_";
export const SCIM_TOKEN_PREFIX = "vbs_";
export const CLI_TOKEN_PREFIX = "vbc_";

export const isCliBearer = (bearer: string): boolean => bearer.startsWith(CLI_TOKEN_PREFIX);

export type OrgTokenKind = "door" | "scim";

const TOKEN_SHAPES: Record<OrgTokenKind, { bearer: string; id: string }> = {
  door: { bearer: DOOR_TOKEN_PREFIX, id: "tok_" },
  scim: { bearer: SCIM_TOKEN_PREFIX, id: "scim_" },
};

export interface MintedDoorToken {
  token: string;
  tokenId: string;
  tokenHash: string;
}

export const hashDoorToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

export const tokenKindOf = (tokenId: string): OrgTokenKind =>
  tokenId.startsWith(TOKEN_SHAPES.scim.id) ? "scim" : "door";

export const mintOrgToken = (kind: OrgTokenKind): MintedDoorToken => {
  const shape = TOKEN_SHAPES[kind];
  const token = `${shape.bearer}${crypto.randomBytes(32).toString("hex")}`;
  return {
    token,
    tokenId: `${shape.id}${crypto.randomBytes(6).toString("hex")}`,
    tokenHash: hashDoorToken(token),
  };
};

export const mintDoorToken = (): MintedDoorToken => mintOrgToken("door");

export const tokensEqual = (presented: string, expected: string): boolean => {
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

export const bearerFrom = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
};
