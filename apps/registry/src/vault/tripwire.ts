import type { FastifyInstance } from "fastify";
import { VibtraError } from "../errors.js";
import { SEALED_PREFIX, type VaultSealer } from "./seal.js";

const ENVELOPE_PREFIX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.v[0-9]+\.$/;

export interface CiphertextTripwire {
  readonly markers: readonly string[];
  catches(body: string): boolean;
}

export const createCiphertextTripwire = (sealer: VaultSealer | undefined): CiphertextTripwire => {
  const markers = [...new Set([SEALED_PREFIX, ...(sealer?.envelopePrefixes ?? [])])];
  const malformed = markers.filter((marker) => !ENVELOPE_PREFIX.test(marker));
  if (malformed.length > 0) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "The vault sealer declares an envelope prefix the ciphertext tripwire cannot use",
      detail:
        `got ${malformed.map((marker) => JSON.stringify(marker)).join(", ")}; an envelope prefix is a lower-case name, ` +
        'a version and two dots, like the envelopePrefix of the local sealer. The registry refuses to start rather than run a tripwire that misses its sealed rows.',
    });
  }
  return { markers, catches: (body) => markers.some((marker) => body.includes(marker)) };
};

export const installCiphertextTripwire = (app: FastifyInstance, tripwire: CiphertextTripwire): void => {
  app.addHook("onSend", async (_req, reply, payload) => {
    if (typeof payload === "string" && tripwire.catches(payload)) {
      void reply.code(500).type("application/json; charset=utf-8");
      return JSON.stringify(
        new VibtraError({
          code: "INTERNAL",
          message: "Refusing to send this response",
          detail:
            "the response body contained a sealed vault envelope — the vault ciphertext tripwire blocked it; " +
            "this is a bug in the registry, not in your request",
        }).toJSON(),
      );
    }
    return payload;
  });
};
