import type { FastifyInstance, FastifyRequest } from "fastify";
import { VibtraError } from "../errors.js";
import {
  CONSOLE_API_PREFIX,
  ConsoleOrgNameRequest,
  type ConsoleSession,
} from "@vibtra/console-api";
import type { RegistrySession } from "../auth/session.js";
import type { RegistryService } from "../service.js";
import { appendVaultAudit } from "../vault/operations.js";
import { forbidden, notFound, refuseWithStatus, sendConsole } from "./respond.js";
import type { ConsoleApiContext } from "./routes.js";

export const ORG_RENAME_REFUSAL =
  "Only an owner can rename this organisation. The name is what every page, every refusal sentence and every " +
  "tool's sign-in gate calls you, so it is an owner's decision. Ask one of yours. Nothing was changed.";

export const registerConsoleOrgSettingsRoutes = (
  app: FastifyInstance,
  service: RegistryService,
  ctx: ConsoleApiContext,
  sessionOf: (req: FastifyRequest) => RegistrySession,
  sessionView: (claims: RegistrySession) => Promise<ConsoleSession>,
): void => {
  const tenancy = service.tenancy;
  if (tenancy === undefined) return;
  const now = ctx.now ?? (() => new Date());

  app.post(`${CONSOLE_API_PREFIX}/org/name`, async (req, reply) => {
    const claims = sessionOf(req);

    if (claims.role !== "owner") {
      return forbidden(reply, "Only an owner can rename this organisation", ORG_RENAME_REFUSAL);
    }

    const parsed = ConsoleOrgNameRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      return refuseWithStatus(
        reply,
        400,
        "VALIDATION",
        "That organisation name is not valid",
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") +
          " — a name is 1 to 64 characters. Nothing was changed.",
      );
    }
    const name = parsed.data.name.trim();
    if (name === "") {
      return refuseWithStatus(
        reply,
        400,
        "VALIDATION",
        "That organisation name is not valid",
        "a name of only spaces is not a name — this organisation would have nothing to be called on any page. " +
          "Nothing was changed.",
      );
    }

    const before = await tenancy.getOrg(claims.orgId);
    if (before === undefined) {
      return notFound(reply, "No such organisation", `org ${claims.orgId} is not in this registry's tenancy store`);
    }

    const previousName = before.name;

    await tenancy.setOrgName(claims.orgId, name);

    const auth = ctx.auth;
    if (auth !== undefined) {
      try {
        await auth.members.renameOrg(claims.orgId, name);
      } catch (cause) {
        throw new VibtraError({
          code: "INTERNAL",
          message: "This organisation was renamed here but not in the sign-in directory",
          detail:
            `every page and every refusal sentence now says ${JSON.stringify(name)}; the organisation switcher ` +
            `at the top of the window still says ${JSON.stringify(previousName)} until this is retried. ` +
            (cause instanceof Error ? cause.message : String(cause)),
        });
      }
    }

    const vault = service.vault;
    if (vault !== undefined) {
      await appendVaultAudit(
        vault,
        {
          orgId: claims.orgId,
          event: "org.renamed",
          actorKind: "admin",
          actor: claims.email,
          outcome: "allowed",
          detail: `renamed from ${JSON.stringify(previousName)} to ${JSON.stringify(name)}`,
        },
        now().toISOString(),
      );
    }

    return sendConsole(reply, "POST /org/name", await sessionView(claims));
  });
};
