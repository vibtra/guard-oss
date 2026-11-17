import { describe, expect, it } from "vitest";
import {
  SEALED_PREFIX,
  buildVaultKeyRing,
  createVaultSealer,
  emptyResealCounts,
  formatRotationLine,
  parseVaultKey,
  sealedKeyId,
  splitVaultKeyList,
  tallySealedRow,
  type ResealCounts,
  type SealBinding,
  type VaultSealer,
} from "@vibtra/registry/src/vault/seal.ts";
import { createSealerRing } from "@vibtra/registry/src/vault/sealer-ring.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);
const BINDING: SealBinding = { orgId: "org_vault", connectionId: "conn_vault" };
const SECRET = "made-up-credential";
const NOT_A_KEY_DETAIL = "expected 64 hex characters (openssl rand -hex 32) or base64 of exactly 32 bytes; the value itself is never echoed, by design";

const thrown = (attempt: () => unknown): unknown => {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

const counts = (scanned: number, current: number, stale: number, unreadable: number, unreadableKeyIds: string[] = []): ResealCounts => ({ scanned, current, stale, unreadable, unreadableKeyIds });

describe("parseVaultKey", () => {
  it("reads 64 hex characters in either case, with surrounding whitespace", () => {
    expect(parseVaultKey(` ${"0f".repeat(32)}\n`)).toEqual(Buffer.alloc(32, 0x0f));
    expect(parseVaultKey("0F".repeat(32))).toEqual(Buffer.alloc(32, 0x0f));
  });

  it("reads base64 or base64url of exactly 32 bytes, padded or not", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 250 - i));
    expect(parseVaultKey(bytes.toString("base64"))).toEqual(bytes);
    expect(parseVaultKey(bytes.toString("base64").replace(/=$/, ""))).toEqual(bytes);
    expect(parseVaultKey(bytes.toString("base64url"))).toEqual(bytes);
  });

  it("refuses anything else under its label, and never echoes the value", () => {
    const refused = ["", "0".repeat(63), "0".repeat(65), `x${"0".repeat(64)}`, `${"0".repeat(64)}x`, Buffer.alloc(31).toString("base64"), `${"A".repeat(43)}==`, `!${"A".repeat(43)}`, "not a key at all"];
    for (const raw of refused) {
      const error = thrown(() => parseVaultKey(raw));
      expect(error, JSON.stringify(raw)).toMatchObject({ name: "VibtraError", code: "VALIDATION", message: "VIBTRA_VAULT_KEY is not a 256-bit key", detail: NOT_A_KEY_DETAIL });
    }
    expect(thrown(() => parseVaultKey("not a key", "MADE_UP_LABEL"))).toMatchObject({ message: "MADE_UP_LABEL is not a 256-bit key" });
  });
});

describe("sealedKeyId", () => {
  it("names the key id of a vault envelope and nothing else", () => {
    const sealed = createVaultSealer(KEY_A).seal(SECRET, BINDING);
    const id = createVaultSealer(KEY_A).keyId;
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(sealedKeyId(sealed)).toBe(id);
    expect(sealedKeyId(sealed.slice(SEALED_PREFIX.length))).toBeUndefined();
    expect(sealedKeyId(`kms.v1.${sealed.slice(SEALED_PREFIX.length)}`)).toBeUndefined();
    expect(sealedKeyId(`vault.v2.${sealed.slice(SEALED_PREFIX.length)}`)).toBeUndefined();
    expect(sealedKeyId(`${sealed}.extra`)).toBeUndefined();
    expect(sealedKeyId(sealed.split(".").slice(0, -1).join("."))).toBeUndefined();
    for (const badId of [id.toUpperCase(), `${id}0`, id.slice(1), `x${id.slice(1)}`, `${id.slice(1)}x`]) {
      expect(sealedKeyId(`${SEALED_PREFIX}${badId}.iv.tag.ct`), badId).toBeUndefined();
    }
  });
});

describe("splitVaultKeyList", () => {
  it("splits on commas, trims each entry and drops empty ones", () => {
    expect(splitVaultKeyList(undefined)).toEqual([]);
    expect(splitVaultKeyList("")).toEqual([]);
    expect(splitVaultKeyList(` ${KEY_A} ,, ${KEY_B},`)).toEqual([KEY_A, KEY_B]);
  });
});

describe("buildVaultKeyRing", () => {
  it("keeps the current key first and each distinct previous key once, in order", () => {
    const ring = buildVaultKeyRing(KEY_B, [KEY_A, KEY_C, KEY_A]);
    expect(ring.current.key).toEqual(Buffer.from(KEY_B, "hex"));
    expect(ring.previous.map((entry) => entry.key)).toEqual([Buffer.from(KEY_A, "hex"), Buffer.from(KEY_C, "hex")]);
    expect(ring.previous.map((entry) => entry.keyId)).toEqual([createVaultSealer(KEY_A).keyId, createVaultSealer(KEY_C).keyId]);
    expect(buildVaultKeyRing(KEY_B).previous).toEqual([]);
  });

  it("names the previous entry it cannot read", () => {
    expect(thrown(() => buildVaultKeyRing(KEY_B, [KEY_A, "not a key"]))).toMatchObject({ code: "VALIDATION", message: "VIBTRA_VAULT_KEY_PREVIOUS entry 2 is not a 256-bit key" });
  });

  it("refuses the current key listed as a previous key, naming the entry and fingerprint but neither key", () => {
    const error = thrown(() => buildVaultKeyRing(KEY_B, [KEY_A, KEY_B])) as { code: string; message: string; detail: string };
    expect(error).toMatchObject({ name: "VibtraError", code: "VALIDATION", message: "VIBTRA_VAULT_KEY is also listed in VIBTRA_VAULT_KEY_PREVIOUS" });
    expect(error.detail).toBe(
      `entry 2 of VIBTRA_VAULT_KEY_PREVIOUS is the current key (fingerprint ${createVaultSealer(KEY_B).keyId}) — the previous list is for keys you have rotated AWAY from, and leaving the current one in it makes an unfinished rotation indistinguishable from a finished one. Neither key is echoed.`,
    );
    expect(error.detail).not.toContain(KEY_B);
  });
});

describe("tallySealedRow", () => {
  it("counts current, previous and unreadable rows and says which to re-seal", async () => {
    const sealer = createVaultSealer(KEY_B, [KEY_A]);
    const stranger = createVaultSealer(KEY_C);
    const tally = emptyResealCounts();
    expect(tally).toEqual(counts(0, 0, 0, 0));
    expect(await tallySealedRow(tally, sealer, sealer.seal(SECRET, BINDING))).toBe(false);
    expect(await tallySealedRow(tally, sealer, createVaultSealer(KEY_A).seal(SECRET, BINDING))).toBe(true);
    expect(await tallySealedRow(tally, sealer, stranger.seal(SECRET, BINDING))).toBe(false);
    expect(await tallySealedRow(tally, sealer, stranger.seal(SECRET, BINDING))).toBe(false);
    expect(await tallySealedRow(tally, sealer, "not an envelope")).toBe(false);
    expect(tally).toEqual(counts(5, 1, 1, 3, [stranger.keyId]));
  });
});

describe("formatRotationLine", () => {
  it("says every row is current when nothing is stale or unreadable", () => {
    expect(formatRotationLine({ connections: counts(2, 2, 0, 0), tools: counts(1, 1, 0, 0) }, ["aaaaaaaaaaaa"])).toBe(
      "vault key ring: current aaaaaaaaaaaa (no previous keys configured) — all 2 connection credentials and 1 tool secret are sealed under the current key",
    );
    expect(formatRotationLine({ connections: counts(1, 1, 0, 0), tools: counts(0, 0, 0, 0), deployTargets: counts(2, 2, 0, 0), guardSigningKeys: counts(1, 1, 0, 0) }, ["aaaaaaaaaaaa"])).toBe(
      "vault key ring: current aaaaaaaaaaaa (no previous keys configured) — all 1 connection credential and 0 tool secrets and 2 deploy targets and 1 Guard signing key are sealed under the current key",
    );
  });

  it("counts stale rows in every table and says how to finish the rotation", () => {
    const census = { connections: counts(3, 1, 2, 0), tools: counts(1, 1, 0, 0), deployTargets: counts(0, 0, 0, 0), guardSigningKeys: counts(1, 0, 1, 0) };
    expect(formatRotationLine(census, ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"])).toBe(
      "vault key ring: current aaaaaaaaaaaa, previous bbbbbbbbbbbb cccccccccccc — 2 of 3 connection credentials and 0 of 1 tool secret and 0 of 0 deploy targets and 1 of 1 Guard signing key are still sealed under a previous key — run \"pnpm --filter @vibtra/registry reseal\" to finish the rotation",
    );
  });

  it("names the unknown key ids of unreadable rows once each, and says they must be re-entered", () => {
    const census = {
      connections: counts(2, 1, 0, 1, ["0123456789ab"]),
      tools: counts(2, 1, 0, 1, ["0123456789ab"]),
      integrations: counts(1, 1, 0, 0),
      modelGateways: counts(1, 0, 0, 1, ["ba9876543210"]),
    };
    expect(formatRotationLine(census, ["aaaaaaaaaaaa"])).toBe(
      "vault key ring: current aaaaaaaaaaaa (no previous keys configured) — 1 of 2 connection credentials and 1 of 2 tool secrets and 1 of 1 1Password integration and 0 of 1 model gateway are sealed under the current key; 3 rows name a key this registry does not hold (0123456789ab ba9876543210) and cannot be re-sealed — those credentials must be re-entered",
    );
  });

  it("says when an unreadable row is not a vault envelope at all", () => {
    expect(formatRotationLine({ connections: counts(1, 0, 0, 1), tools: counts(0, 0, 0, 0) }, ["aaaaaaaaaaaa"])).toBe(
      "vault key ring: current aaaaaaaaaaaa (no previous keys configured) — 0 of 1 connection credential and 0 of 0 tool secrets are sealed under the current key; 1 row names a key this registry does not hold (no readable key id) and cannot be re-sealed — those rows are not vault envelopes this registry recognises; check that they were not altered before re-entering anything",
    );
  });

  it("reports stale rows before unreadable ones when a census has both", () => {
    expect(formatRotationLine({ connections: counts(2, 0, 1, 1, ["0123456789ab"]), tools: counts(0, 0, 0, 0) }, ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])).toBe(
      "vault key ring: current aaaaaaaaaaaa, previous bbbbbbbbbbbb — 1 of 2 connection credentials and 0 of 0 tool secrets are still sealed under a previous key — run \"pnpm --filter @vibtra/registry reseal\" to finish the rotation; 1 row names a key this registry does not hold (0123456789ab) and cannot be re-sealed — those credentials must be re-entered",
    );
  });
});

describe("the environment vault sealer", () => {
  const sealer = createVaultSealer(KEY_B, [KEY_A]);

  it("lists its current key first, then its previous keys, and one envelope prefix", () => {
    expect(sealer.keyIds).toEqual([createVaultSealer(KEY_B).keyId, createVaultSealer(KEY_A).keyId]);
    expect(sealer.keyId).toBe(sealer.keyIds[0]);
    expect([sealer.envelopePrefix, sealer.envelopePrefixes]).toEqual([SEALED_PREFIX, [SEALED_PREFIX]]);
  });

  it("says a value that is not a vault envelope is malformed", () => {
    expect(sealer.keyState("not an envelope")).toBe("malformed");
    expect(sealer.keyState(`${SEALED_PREFIX}abc.def`)).toBe("malformed");
  });

  it("leaves a row already on the current key untouched when it reseals", () => {
    const sealed = sealer.seal(SECRET, BINDING);
    expect(sealer.reseal(sealed, BINDING)).toBe(sealed);
    const moved = sealer.reseal(createVaultSealer(KEY_A).seal(SECRET, BINDING), BINDING);
    expect(sealedKeyId(moved)).toBe(sealer.keyId);
  });

  it("refuses to open a value without the envelope marker", () => {
    expect(thrown(() => sealer.open(`kms.v1.${SECRET}`, BINDING))).toMatchObject({
      name: "VibtraError",
      code: "INTERNAL",
      message: "Stored credential is not a sealed envelope",
      detail: "the stored value does not carry THIS key family's envelope marker (vault.v1.) — refusing to interpret it",
    });
  });

  it("refuses an envelope with the wrong number of segments", () => {
    expect(thrown(() => sealer.open(`${SEALED_PREFIX}${sealer.keyId}.iv.tag`, BINDING))).toMatchObject({
      code: "INTERNAL",
      message: "Stored credential envelope is malformed",
      detail: "expected 4 envelope segments, found 3",
    });
  });

  it("refuses a row sealed under a key it does not hold, naming the row's key and the keys it holds", () => {
    const stranger = createVaultSealer(KEY_C);
    const error = thrown(() => sealer.open(stranger.seal(SECRET, BINDING), BINDING)) as { detail: string };
    expect(error).toMatchObject({ code: "INTERNAL", message: "This connection was sealed with a different vault key" });
    expect(error.detail).toBe(
      `the row was sealed under key ${stranger.keyId}, this registry holds ${sealer.keyIds.join(", ")} (current first) — add the original key to VIBTRA_VAULT_KEY_PREVIOUS and run the reseal command (see README, "Rotating the vault key"), or have the admin re-enter the credential under the new one`,
    );
  });

  it("refuses a row read under the wrong identity without saying what is inside", () => {
    const error = thrown(() => sealer.open(sealer.seal(SECRET, BINDING), { ...BINDING, orgId: "org_other" }));
    expect(error).toMatchObject({
      code: "INTERNAL",
      message: "Stored credential could not be decrypted",
      detail: "authenticated decryption failed — the ciphertext is bound to its org and connection id, so this means the row was moved, altered, or is being read under the wrong identity",
    });
  });
});

describe("a sealer ring", () => {
  const refusingOpen = (inner: VaultSealer): VaultSealer => ({
    ...inner,
    open: () => {
      throw new Error("made-up: this member must not open the row");
    },
  });

  it("is the primary itself when there is no decrypt-only member", () => {
    const primary = createVaultSealer(KEY_B);
    expect(createSealerRing(primary, [])).toBe(primary);
  });

  it("lists every member's key ids and envelope prefixes once, primary first", () => {
    const ring = createSealerRing(createVaultSealer(KEY_B, [KEY_A]), [createVaultSealer(KEY_C, [KEY_A])]);
    expect(ring.keyIds).toEqual([createVaultSealer(KEY_B).keyId, createVaultSealer(KEY_A).keyId, createVaultSealer(KEY_C).keyId]);
    expect(ring.keyId).toBe(createVaultSealer(KEY_B).keyId);
    expect(ring.envelopePrefixes).toEqual([SEALED_PREFIX]);
  });

  it("keeps a row the primary sealed current, even when a decrypt-only member also holds that key", async () => {
    const primary = createVaultSealer(KEY_B);
    const ring = createSealerRing(primary, [createVaultSealer(KEY_C, [KEY_B])]);
    const sealed = primary.seal(SECRET, BINDING);
    expect(await ring.keyState(sealed)).toBe("current");
    expect(await ring.reseal(sealed, BINDING)).toBe(sealed);
  });

  it("opens and reseals a row under the primary's own previous key with the primary, not a member that also holds it", async () => {
    const ring = createSealerRing(createVaultSealer(KEY_B, [KEY_A]), [refusingOpen(createVaultSealer(KEY_A))]);
    const sealed = createVaultSealer(KEY_A).seal(SECRET, BINDING);
    expect(await ring.keyState(sealed)).toBe("previous");
    expect(await ring.open(sealed, BINDING)).toBe(SECRET);
    const moved = await ring.reseal(sealed, BINDING);
    expect(sealedKeyId(moved)).toBe(createVaultSealer(KEY_B).keyId);
    expect(await ring.open(moved, BINDING)).toBe(SECRET);
  });

  it("says a row no member holds is unknown, and a malformed one malformed", async () => {
    const ring = createSealerRing(createVaultSealer(KEY_B), [createVaultSealer(KEY_A)]);
    expect(await ring.keyState(createVaultSealer(KEY_C).seal(SECRET, BINDING))).toBe("unknown");
    expect(await ring.keyState("not an envelope")).toBe("malformed");
  });
});
