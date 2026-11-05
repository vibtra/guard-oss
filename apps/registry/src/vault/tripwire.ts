import type { FastifyInstance } from "fastify";
import { VibtraError } from "../errors.js";
import { SEALED_PREFIX } from "./seal.js";
import { TRANSIT_SEALED_PREFIX } from "./transit-sealer.js";

export { SEALED_PREFIX, TRANSIT_SEALED_PREFIX };

const CIPHERTEXT_MARKERS: readonly string[] = [SEALED_PREFIX, TRANSIT_SEALED_PREFIX];

export const installCiphertextTripwire = (app: FastifyInstance): void => {
  app.addHook("onSend", async (_req, reply, payload) => {
    if (typeof payload === "string" && CIPHERTEXT_MARKERS.some((marker) => payload.includes(marker))) {
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
