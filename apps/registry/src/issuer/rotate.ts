import { createJwk } from "better-auth/plugins/jwt";
import type { RegistryServer } from "../server.js";
import { ID_TOKEN_TTL_SECONDS, toolGateJwtPlugin } from "./provider.js";

interface JwksAdapter {
  findMany<T>(data: { model: string }): Promise<T[]>;
  update<T>(data: { model: string; where: Array<{ field: string; value: string }>; update: Record<string, unknown> }): Promise<T | null>;
  delete(data: { model: string; where: Array<{ field: string; value: string }> }): Promise<void>;
}

interface JwksRow {
  id: string;
  createdAt: Date;
  expiresAt?: Date | null;
  alg?: string | null;
}

export interface IssuerKeyRotation {
  minted: string;
  retired: string[];
  revoked: string[];
  keys: string[];
}

const newestFirst = (a: JwksRow, b: JwksRow): number =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

const isLive = (row: JwksRow, now: Date): boolean =>
  row.expiresAt === undefined || row.expiresAt === null || new Date(row.expiresAt) > now;

export const rotateIssuerKey = async (
  registry: Pick<RegistryServer, "auth">,
  options: {
    baseUrl: string;
    gateSigningSecret: string;
    revoke?: boolean;
  },
): Promise<IssuerKeyRotation> => {
  const auth = registry.auth;
  if (auth === undefined) {
    throw new Error(
      "this registry has no sign-in, so it has no tool-gate signing key to rotate — the issuer exists only in " +
        "hosted mode (REGISTRY_MODE=hosted). Refusing to report a rotation over a key set this command never opened.",
    );
  }

  const adapter = (await auth.adapter()) as unknown as JwksAdapter;
  const before = (await adapter.findMany<JwksRow>({ model: "jwks" })).slice().sort(newestFirst);
  const now = new Date();
  const live = before.filter((row) => isLive(row, now));

  const doomed = options.revoke === true ? before : live;

  const mintContext = { context: await auth.auth.$context } as unknown as Parameters<typeof createJwk>[0];
  const minted = await createJwk(mintContext, toolGateJwtPlugin(options.baseUrl, options.gateSigningSecret).options);

  const retired: string[] = [];
  const revoked: string[] = [];
  for (const row of doomed) {
    if (options.revoke === true) {
      await adapter.delete({ model: "jwks", where: [{ field: "id", value: row.id }] });
      revoked.push(row.id);
    } else {
      await adapter.update({
        model: "jwks",
        where: [{ field: "id", value: row.id }],
        update: { expiresAt: now },
      });
      retired.push(row.id);
    }
  }

  const after = (await adapter.findMany<JwksRow>({ model: "jwks" })).slice().sort(newestFirst);
  if (after.length === 0) {
    throw new Error(
      "rotation left the `jwks` table EMPTY — refusing to report success. Every deployed tool's sign-in is broken " +
        "until a key exists; the registry mints one on the next signature, but that is a recovery and not what this " +
        "command promised.",
    );
  }
  const held = new Set(after.map((row) => row.id));
  const missing = retired.filter((kid) => !held.has(kid));
  if (missing.length > 0) {
    throw new Error(
      `rotation retired ${missing.join(", ")} but the key set no longer holds ${missing.length === 1 ? "it" : "them"} — ` +
        "refusing to report success. A retired key MUST stay in the table so /oauth2/jwks keeps serving its public " +
        "half; without it every token already in a browser stopped verifying, which is the `--revoke` outcome and " +
        "was not asked for.",
    );
  }
  const rowsAfter = new Map(after.map((row) => [row.id, row]));
  const stillLive = retired.filter((kid) => {
    const row = rowsAfter.get(kid);
    return row !== undefined && isLive(row, new Date());
  });
  if (stillLive.length > 0) {
    throw new Error(
      `rotation retired ${stillLive.join(", ")} and the key set still reports ${stillLive.length === 1 ? "it" : "them"} as ` +
        "LIVE — refusing to report success. The `expiresAt` stamp did not take, so the old key is still eligible to " +
        "sign and only the newer key's existence is keeping it from being chosen; re-run this command, and if it " +
        "fails the same way the `jwks` row is not writable by this process.",
    );
  }

  const survived = revoked.filter((kid) => held.has(kid));
  if (survived.length > 0) {
    throw new Error(
      `rotation was asked to revoke ${survived.join(", ")} and the key set still holds ${survived.length === 1 ? "it" : "them"} — ` +
        "refusing to report success. Those keys are still served at /oauth2/jwks, so the artifacts this was meant to " +
        "sign out are still signed in.",
    );
  }

  const signing = after.filter((row) => isLive(row, new Date())).sort(newestFirst)[0];
  if (signing === undefined || signing.id !== minted.id) {
    throw new Error(
      `rotation minted ${minted.id} but the key this registry would sign with is ` +
        `${signing === undefined ? "none at all" : signing.id} — refusing to report success. The previous key was ` +
        "not retired, or a second process minted one at the same moment; re-run this command.",
    );
  }

  const keys = [minted.id, ...after.filter((row) => row.id !== minted.id).map((row) => row.id)];
  return { minted: minted.id, retired, revoked, keys };
};

export const formatIssuerRotation = (rotation: IssuerKeyRotation): string[] => {
  const lines = [`new signing key: ${rotation.minted} (ES256)`];
  if (rotation.retired.length > 0) {
    lines.push(
      `retired, still served at /oauth2/jwks: ${rotation.retired.join(", ")} — every ID token already in a browser ` +
        `keeps verifying until its own exp, at most ${ID_TOKEN_TTL_SECONDS / 3600} hours from when it was issued. ` +
        "Nobody was signed out.",
    );
  }
  if (rotation.revoked.length > 0) {
    lines.push(
      `REVOKED, no longer served at /oauth2/jwks: ${rotation.revoked.join(", ")} — every live artifact signed under ` +
        "these is signed out at its next request, and everyone has to sign in again.",
    );
  }
  if (rotation.retired.length === 0 && rotation.revoked.length === 0) {
    lines.push("no previous key was live — this registry had not signed anything yet, so nothing was retired.");
  }
  lines.push(`key set now: ${rotation.keys.join(", ")}`);
  return lines;
};
