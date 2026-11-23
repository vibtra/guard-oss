import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { requireAdmin } from "../console-api/guard.js";
import { forbidden } from "../console-api/respond.js";
import { VibtraError } from "../errors.js";
import { requireSession } from "./session.js";

type RouteAccess =
  | { readonly level: "public" }
  | { readonly level: "device" }
  | { readonly level: "member" }
  | { readonly level: "admin"; readonly act: string; readonly because?: string }
  | { readonly level: "owner"; readonly act: string; readonly because: string };

export type AccessLevel = RouteAccess["level"];

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

const declared = (routeAccess: RouteAccess) => ({ config: { access: routeAccess } });

export const access = {
  public: declared({ level: "public" }),
  device: declared({ level: "device" }),
  member: declared({ level: "member" }),
  admin: (act: string, because?: string) => declared(because === undefined ? { level: "admin", act } : { level: "admin", act, because }),
  owner: (act: string, because: string) => declared({ level: "owner", act, because }),
};

export const declarePluginRoutes = (scope: FastifyInstance, routeAccess: { config: { access: RouteAccess } }): void => {
  scope.addHook("onRoute", (route) => {
    route.config = { ...route.config, access: route.config?.access ?? routeAccess.config.access };
  });
};

export type DeviceCheck = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly access: AccessLevel | undefined;
}

export const installRouteAccess = (app: FastifyInstance, device: DeviceCheck): (() => RegisteredRoute[]) => {
  const registered: RouteOptions[] = [];
  const routes = (): RegisteredRoute[] =>
    registered.flatMap((route) => [route.method].flat().map((method) => ({ method, url: route.url, access: route.config?.access?.level })));

  app.addHook("onRoute", (route) => {
    registered.push(route);
  });

  app.addHook("onReady", async () => {
    const undeclared = routes().filter((route) => route.access === undefined);
    if (undeclared.length === 0) return;
    throw new VibtraError({
      code: "INTERNAL",
      message: "A registry route does not say who may call it",
      detail:
        `${undeclared.map((route) => `${route.method} ${route.url}`).join(", ")} registered with no access level. Pass access.public, ` +
        "access.device, access.member, access.admin(act) or access.owner(act, because) from apps/registry/src/auth/access.ts as the " +
        "route's options, or declarePluginRoutes for a plugin's routes.",
    });
  });

  app.addHook("preHandler", async (req, reply) => {
    const routeAccess = req.routeOptions.config.access;
    switch (routeAccess?.level) {
      case undefined:
      case "public":
        return undefined;
      case "device":
        return device(req, reply);
      case "member":
        requireSession(req);
        return undefined;
      case "admin":
        requireAdmin(requireSession(req), routeAccess.act, routeAccess.because);
        return undefined;
      case "owner": {
        const session = requireSession(req);
        requireAdmin(session, routeAccess.act, routeAccess.because);
        if (session.role === "owner") return undefined;
        return forbidden(reply, "Owners only", `Only an organisation owner can ${routeAccess.act}. ${routeAccess.because}`);
      }
    }
  });

  return routes;
};
