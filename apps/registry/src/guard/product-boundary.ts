// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyInstance, FastifyReply } from "fastify";
import { AUTH_BASE_PATH } from "../auth/fastify.js";
import { guardEntryPageCsp, guardLoginPage, guardStartPage, type GuardSignIn } from "./entry-pages.js";

type AuthDoor = readonly [methods: readonly string[], path: string];

const AUTH_DOORS: readonly AuthDoor[] = [
  [["POST"], "/sign-in/social"],
  [["GET"], "/callback/:id"],
  [["POST"], "/sign-in/sso"],
  [["GET"], "/sso/callback/:id"],
  [["GET"], "/get-session"],
  [["POST"], "/sign-out"],
  [["POST"], "/organization/accept-invitation"],
  [["GET"], "/ok"],
];

const TEST_AUTH_DOORS: readonly AuthDoor[] = [
  [["POST"], "/sign-up/email"],
  [["POST"], "/sign-in/email"],
];

const AUTH_PARAM = /^[A-Za-z0-9_-]{1,260}$/;

const doorMatches = (pattern: string, path: string): boolean => {
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((segment, i) => (segment.startsWith(":") ? AUTH_PARAM.test(got[i]!) : segment === got[i]));
};

export function guardAuthRequestAllowed(method: string, url: string, options: { testAuth?: boolean } = {}): boolean {
  const raw = url.split("?")[0] ?? "";
  let normalised: string;
  try {
    normalised = new URL(url, "http://guard.invalid").pathname;
  } catch {
    return false;
  }
  if (raw !== normalised || !raw.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const path = raw.slice(AUTH_BASE_PATH.length);
  const doors = options.testAuth === true ? [...AUTH_DOORS, ...TEST_AUTH_DOORS] : AUTH_DOORS;
  return doors.some(([methods, pattern]) => methods.includes(method) && doorMatches(pattern, path));
}

export function guardRouteAllowed(route: string): boolean {
  if (["/", "/healthz", "/login", "/signin", "/start", "/privacy", "/terms", "/pricing"].includes(route)) return true;
  if (/^\/(?:api\/guard\/v1|assets\/guard|landing)(?:\/|$)/.test(route)) return true;
  if (/^\/:handle\/guard(?:\/|$)/.test(route)) return true;
  return /^\/api\/console\/(?:org\/name|guard|session|people|groups|policy-requests|policy-grants|org-settings|registration|sso|account|org-joining)(?:\/|$)/.test(route);
}

export function installGuardBoundary(app: FastifyInstance, options: { testAuth?: boolean } = {}): void {
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    const allowed = route === `${AUTH_BASE_PATH}/*` ? guardAuthRequestAllowed(request.method, request.url, options) : !!route && guardRouteAllowed(route);
    if (!allowed) return reply.code(404).header("cache-control", "no-store").send({ error: "Not part of Guard" });
  });
}

export type { GuardSignIn } from "./entry-pages.js";

export function registerGuardEntryPages(app: FastifyInstance, signIn: GuardSignIn = { provider: "google", label: "Google" }): void {
  const login = guardLoginPage(signIn);
  const start = guardStartPage();
  const csp = guardEntryPageCsp();
  const page = (html: string) => async (_request: unknown, reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", csp)
      .header("cache-control", "no-store")
      .header("referrer-policy", "same-origin")
      .header("x-content-type-options", "nosniff")
      .send(html);
  app.get("/login", page(login));
  for (const bare of ["/landing", "/landing/"]) app.get(bare, async (_request, reply) => reply.redirect("/", 301));
  app.get("/start", page(start));
}
