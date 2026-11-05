import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { VibtraError, type VibtraErrorShape } from "../errors.js";
import {
  CONSOLE_ADMIN_ONLY_CODE,
  CONSOLE_DEV_ORIGINS,
  CSRF_COOKIE,
  CSRF_HEADER,
  ORG_HANDLE_HEADER,
} from "@vibtra/console-api";
import { parseCookies } from "../auth/cookies.js";
import { isOrgAdmin, requireSession, type RegistrySession } from "../auth/session.js";

export interface ConsoleGuardContext {
  baseUrl: string;
  secureCookies: boolean;
  extraTrustedOrigins?: readonly string[];
}

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export const allowedConsoleOrigins = (baseUrl: string, extra: readonly string[] = []): string[] => {
  const own = originOf(baseUrl);
  const list = own === undefined ? [] : [own];
  if (own !== undefined && own.startsWith("http://")) list.push(...CONSOLE_DEV_ORIGINS);
  list.push(...extra);
  return [...new Set(list)];
};

export const requireConsoleSession = (_ctx: ConsoleGuardContext, req: FastifyRequest): RegistrySession =>
  requireSession(req);

export const csrfSetCookie = (value: string, secure: boolean): string =>
  [
    `${CSRF_COOKIE}=${value}`,
    "Path=/",
    "Max-Age=43200",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

export const mintCsrfToken = (): string => crypto.randomBytes(16).toString("hex");

export const ensureCsrfCookie = (ctx: ConsoleGuardContext, req: FastifyRequest, reply: FastifyReply): string => {
  const existing = parseCookies(req.headers.cookie)[CSRF_COOKIE];
  if (existing !== undefined && existing !== "") return existing;
  const minted = mintCsrfToken();
  void reply.header("set-cookie", csrfSetCookie(minted, ctx.secureCookies));
  return minted;
};

const tokensMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
};

export const requireCsrf = (ctx: ConsoleGuardContext, req: FastifyRequest): void => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const origin = req.headers.origin;
  const allowed = allowedConsoleOrigins(ctx.baseUrl, ctx.extraTrustedOrigins ?? []);
  if (typeof origin !== "string" || origin === "") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "This request did not say where it came from",
      detail: `a state-changing console call must carry an Origin header; allowed: ${allowed.join(", ")}`,
    });
  }
  if (!allowed.includes(origin)) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "That origin may not write to this console",
      detail: `Origin ${JSON.stringify(origin)} is not one of: ${allowed.join(", ")}`,
    });
  }

  const header = req.headers[CSRF_HEADER];
  const presented = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE];
  if (presented === undefined || presented === "") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "This request is missing its CSRF token",
      detail: `send the ${CSRF_COOKIE} cookie's value back in the ${CSRF_HEADER} header on every non-GET console call`,
    });
  }
  if (cookie === undefined || cookie === "" || !tokensMatch(presented, cookie)) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "This request's CSRF token does not match",
      detail: `the ${CSRF_HEADER} header must equal the ${CSRF_COOKIE} cookie this origin set (double-submit)`,
    });
  }
};

export const pathOrgHandle = (req: FastifyRequest): string | undefined => {
  const raw = req.headers[ORG_HANDLE_HEADER];
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  const trimmed = value?.trim().toLowerCase();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

export const WRONG_ORG_REFUSAL = (asked: string, actual: string): { message: string; detail: string } => ({
  message: "That is not the organisation you are signed in to",
  detail:
    `this window is at /${asked} and your session is active in /${actual}. Nothing was read from either. ` +
    `Switch organisation with the switcher at the top of the window, or open /${actual} directly.`,
});

export const requirePathOrg = async (
  req: FastifyRequest,
  org: { orgId: string; handle?: string } | undefined,
  aliases: (orgId: string) => Promise<ReadonlyArray<{ handle: string }>>,
): Promise<void> => {
  const asked = pathOrgHandle(req);
  if (asked === undefined || org === undefined) return;
  if (org.handle === asked) return;
  if ((await aliases(org.orgId)).some((a) => a.handle === asked)) return;
  const { message, detail } = WRONG_ORG_REFUSAL(asked, org.handle ?? org.orgId);
  throw new VibtraError({ code: "POLICY_REFUSED", message, detail });
};

export class ConsoleAdminOnlyError extends VibtraError {
  constructor(message: string, detail: string) {
    super({ code: "POLICY_REFUSED", message, detail });
    this.name = "ConsoleAdminOnlyError";
  }
  override toJSON(): VibtraErrorShape {
    return { ...super.toJSON(), code: CONSOLE_ADMIN_ONLY_CODE as VibtraErrorShape["code"] };
  }
}

const ASK_AN_ADMIN = "Ask one of yours, or an owner can change your role.";

export const requireAdmin = (session: RegistrySession, act: string, because?: string): void => {
  if (isOrgAdmin(session.role)) return;
  throw new ConsoleAdminOnlyError("Admins only", `Only an org owner or admin can ${act}. ${because ?? ASK_AN_ADMIN}`);
};
