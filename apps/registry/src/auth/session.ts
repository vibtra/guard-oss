import type { FastifyInstance, FastifyRequest } from "fastify";
import { VibtraError } from "../errors.js";
import { timed } from "../telemetry.js";
import { CONSOLE_LOGIN_PATH } from "@vibtra/console-api";

export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const isOrgAdmin = (role: OrgRole): boolean => role === "owner" || role === "admin";

export const wireRole = (role: OrgRole): "admin" | "member" => (isOrgAdmin(role) ? "admin" : "member");

export interface RegistrySession {
  userId: string;
  email: string;
  emailVerified: boolean;
  image?: string;
  orgId: string;
  role: OrgRole;
  sessionId?: string;
}

export interface SignedInAccount {
  userId: string;
  email: string;
  emailVerified: boolean;
}

export type SessionResolver = (headers: Headers) => Promise<RegistrySession | undefined>;

const SESSION_SLOT = "vibtraSession";

type SessionSlot = RegistrySession | null | { unreadable: unknown };

interface RequestWithSession {
  [SESSION_SLOT]?: SessionSlot;
}

export const toWebHeaders = (headers: NodeJS.Dict<string | string[]>): Headers => {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) out.append(name, v);
    else out.append(name, value);
  }
  return out;
};

export interface SessionReaderOptions {
  resolve: SessionResolver;
  skipPrefixes?: string[];
}

export const registerSessionReader = (app: FastifyInstance, options: SessionReaderOptions): void => {
  const skip = options.skipPrefixes ?? [];
  app.decorateRequest(SESSION_SLOT, null);
  app.addHook("onRequest", async (req) => {
    if (skip.some((prefix) => req.url === prefix || req.url.startsWith(`${prefix}/`) || req.url.startsWith(`${prefix}?`))) return;
    let slot: SessionSlot;
    try {
      slot = (await timed(req.log, "session", () => options.resolve(toWebHeaders(req.headers)))) ?? null;
    } catch (error) {
      slot = { unreadable: error };
    }
    (req as FastifyRequest & RequestWithSession)[SESSION_SLOT] = slot;
  });
};

const slotOf = (req: FastifyRequest): SessionSlot => (req as FastifyRequest & RequestWithSession)[SESSION_SLOT] ?? null;

const sessionUnreadable = (cause: unknown): VibtraError =>
  new VibtraError(
    {
      code: "INTERNAL",
      message: "Guard could not check your sign-in. Try again in a moment",
      detail: "the session store did not answer; the request was not treated as signed out",
    },
    { cause },
  );

export const readSession = (req: FastifyRequest): RegistrySession | undefined => {
  const slot = slotOf(req);
  if (slot === null) return undefined;
  if ("unreadable" in slot) throw sessionUnreadable(slot.unreadable);
  return slot;
};

export const peekSession = (req: FastifyRequest): RegistrySession | undefined => {
  const slot = slotOf(req);
  return slot === null || "unreadable" in slot ? undefined : slot;
};

export const notSignedIn = (): VibtraError =>
  new VibtraError({
    code: "DEPLOY_AUTH_EXPIRED",
    message: "Sign in to use the console",
    detail: `this door reads the console session; sign in at ${CONSOLE_LOGIN_PATH} and try again`,
  });

export const requireSession = (req: FastifyRequest): RegistrySession => {
  const session = readSession(req);
  if (session === undefined) throw notSignedIn();
  return session;
};
