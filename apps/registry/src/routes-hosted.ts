import type { FastifyInstance } from "fastify";
import { toVibtraError } from "./errors.js";
import { CONSOLE_LOGIN_PATH } from "@vibtra/console-api";
import { sanitizeReturnPath } from "./auth/return-to.js";
import { readSession } from "./auth/session.js";

export const signInRedirect = (returnTo: string | undefined): string =>
  returnTo === undefined ? CONSOLE_LOGIN_PATH : `${CONSOLE_LOGIN_PATH}?return=${encodeURIComponent(returnTo)}`;

export const registerHostedRoutes = (app: FastifyInstance): void => {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      const form: Record<string, string | string[]> = {};
      for (const [key, value] of new URLSearchParams(String(body))) {
        const existing = form[key];
        if (existing === undefined) form[key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else form[key] = [existing, value];
      }
      done(null, form);
    } catch (e) {
      done(toVibtraError(e, "VALIDATION"), undefined);
    }
  });

  app.get("/signin", async (req, reply) => {
    const returnTo = sanitizeReturnPath((req.query as { return?: unknown }).return);
    if (readSession(req) !== undefined) return reply.code(303).header("location", returnTo ?? "/").send();
    return reply.code(303).header("location", signInRedirect(returnTo)).send();
  });
};
