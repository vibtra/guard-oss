import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { VibtraError } from "../errors.js";
import {
  CONSOLE_API_PREFIX,
  ConsoleAllowlistAddition,
  type ConsoleAllowlistRow,
  type ConsoleRegistrationPage,
} from "@vibtra/console-api";
import { registrationOf } from "../config.js";
import { requireSession, type RegistrySession } from "../auth/session.js";
import { classifyAllowlistSubject, type AllowlistRow } from "../registration/store.js";
import type { RegistryService } from "../service.js";
import type { MeteringService } from "../metering/service.js";
import type { ConsoleApiContext } from "./routes.js";
import { requireAdmin } from "./guard.js";
import { forbidden, notFound, sendConsole } from "./respond.js";

const OWNERS_ONLY =
  "Only an owner of the organisation that operates this registry can change who may sign up. " +
  "Ask whoever first claimed it.";

const OPERATOR_ONLY = "Only the organisation that operates this registry manages sign-ups.";

const allowlistRowView = (row: AllowlistRow): ConsoleAllowlistRow => ({
  id: row.id,
  subject: row.subject,
  kind: row.kind,
  ...(row.note === undefined ? {} : { note: row.note }),
  addedBy: row.addedBy,
  addedAt: row.addedAt,
});

export const registerConsoleRegistrationRoutes = (
  app: FastifyInstance,
  service: RegistryService,
  ctx: ConsoleApiContext,
): void => {
  const tenancy = service.tenancy;
  if (tenancy === undefined) return;
  const sessionOf = (req: FastifyRequest): RegistrySession => requireSession(req);
  const registration = registrationOf({ registration: ctx.registration });

  const operatorStoreFor = async (
    claims: RegistrySession,
    reply: FastifyReply,
  ): Promise<NonNullable<RegistryService["registrationAllowlist"]> | undefined> => {
    if (registration.operatorDomain === undefined) {
      void notFound(
        reply,
        "This registry does not manage sign-ups from the console",
        "no REGISTRY_OPERATOR_DOMAIN is configured, so no organisation operates this registry and there is no " +
          "Sign-ups section to answer. Set it to the mail domain of the organisation that runs this deployment.",
      );
      return undefined;
    }
    const org = await tenancy.getOrg(claims.orgId);
    if (org?.domain !== registration.operatorDomain) {
      void forbidden(
        reply,
        OPERATOR_ONLY,
        `${org?.name ?? claims.orgId} does not claim ${registration.operatorDomain}, which is the domain this ` +
          "deployment names as its operator. Sign-ups are a property of the whole registry, so exactly one " +
          "organisation manages them.",
      );
      return undefined;
    }
    const store = service.registrationAllowlist;
    if (store === undefined) {
      void notFound(
        reply,
        "This registry cannot keep a sign-up list",
        "the service was built without a registration allowlist store, so there is nothing to read or write",
      );
      return undefined;
    }
    return store;
  };

  const pageFor = async (
    claims: RegistrySession,
    store: NonNullable<RegistryService["registrationAllowlist"]>,
  ): Promise<ConsoleRegistrationPage> => {
    const metering = (ctx as ConsoleApiContext & { metering?: MeteringService }).metering;
    const budget = metering === undefined ? undefined : await metering.freeBudget();
    const waitlist = metering === undefined ? undefined : await tenancy.listWaitlistedOrgs();
    return {
      mode: registration.mode,
      rows: (await store.list()).map(allowlistRowView),
      mayManage: claims.role === "owner",
      ...(registration.operatorDomain === undefined ? {} : { operatorDomain: registration.operatorDomain }),
      ...(registration.mode === "allowlist" && registration.contactEmail !== undefined
        ? { contactEmail: registration.contactEmail }
        : {}),
      ...(budget === undefined ? {} : { freeBudget: { usedHours: Math.round((budget.usedMinutes / 60) * 10) / 10, budgetHours: budget.budgetMinutes / 60, resetsOn: budget.resetsOn } }),
      ...(waitlist === undefined ? {} : { waitlist: waitlist.map((o) => ({ orgId: o.orgId, name: o.name, createdAt: o.createdAt })) }),
    };
  };

  app.post<{ Params: { id: string } }>(`${CONSOLE_API_PREFIX}/registration/waitlist/:id/admit`, async (req, reply) => {
    const claims = sessionOf(req);
    const store = await operatorStoreFor(claims, reply);
    if (store === undefined) return reply;
    if (!requireOwner(claims, reply, "admit an organisation from the waitlist")) return reply;
    const org = await tenancy.getOrg(req.params.id);
    if (org === undefined || org.status !== "waitlisted") {
      return notFound(reply, "That organisation is not on the waitlist", "it may have been admitted already, or the id is wrong. Nothing was changed.");
    }
    const at = new Date().toISOString();
    await tenancy.setOrgStatus(org.orgId, "active", at);
    if (service.vault !== undefined) {
      const { appendVaultAudit } = await import("../vault/operations.js");
      await appendVaultAudit(service.vault, { orgId: org.orgId, event: "org.waitlist_admitted", actor: claims.email, actorKind: "admin", outcome: "allowed", detail: `admitted from the free-budget waitlist by the operator (${claims.email})` });
    }
    return sendConsole(reply, "POST /registration/waitlist/:id/admit", await pageFor(claims, store));
  });

  const requireOwner = (claims: RegistrySession, reply: FastifyReply, verb: string): boolean => {
    requireAdmin(claims, verb, OWNERS_ONLY);
    if (claims.role === "owner") return true;
    void forbidden(reply, "Owners only", `Only an organisation owner can ${verb}. ${OWNERS_ONLY}`);
    return false;
  };

  app.get(`${CONSOLE_API_PREFIX}/registration`, async (req, reply) => {
    const claims = sessionOf(req);
    const store = await operatorStoreFor(claims, reply);
    if (store === undefined) return reply;
    requireAdmin(claims, "see who may sign up to this registry");
    return sendConsole(reply, "GET /registration", await pageFor(claims, store));
  });

  app.post(`${CONSOLE_API_PREFIX}/registration/allowlist`, async (req, reply) => {
    const claims = sessionOf(req);
    const store = await operatorStoreFor(claims, reply);
    if (store === undefined) return reply;
    if (!requireOwner(claims, reply, "add somebody to the sign-up list")) return reply;

    const parsed = ConsoleAllowlistAddition.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Type an email address or a domain to allow.",
        detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }

    const { subject, kind } = classifyAllowlistSubject(parsed.data.subject);

    const added = await store.add({
      subject,
      kind,
      ...(parsed.data.note === undefined || parsed.data.note === "" ? {} : { note: parsed.data.note }),
      addedBy: claims.email,
    });
    if (added === undefined) {
      const existing = (await store.list()).find((row) => row.subject === subject);
      return forbidden(
        reply,
        `${subject} is already on the sign-up list`,
        existing === undefined
          ? "it is already listed, so nothing was added."
          : `${existing.addedBy} added it on ${existing.addedAt}. Nothing was changed.`,
      );
    }

    return sendConsole(reply, "POST /registration/allowlist", await pageFor(claims, store));
  });

  app.delete<{ Params: { id: string } }>(
    `${CONSOLE_API_PREFIX}/registration/allowlist/:id`,
    async (req, reply) => {
      const claims = sessionOf(req);
      const store = await operatorStoreFor(claims, reply);
      if (store === undefined) return reply;
      if (!requireOwner(claims, reply, "remove somebody from the sign-up list")) return reply;

      if (!(await store.remove(req.params.id))) {
        return notFound(
          reply,
          "No such row on the sign-up list",
          `${JSON.stringify(req.params.id)} is not a row on this registry's sign-up list. It may have been ` +
            "removed already.",
        );
      }
      return sendConsole(reply, "DELETE /registration/allowlist/:id", await pageFor(claims, store));
    },
  );
};
