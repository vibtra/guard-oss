import type { GuardSigner } from "@vibtra/guard-contract/signing";
import type { FastifyInstance } from "fastify";
import { registerGuardConsoleRoutes } from "./console-routes.js";
import { createGuardService, type GuardAuditEntry, type GuardPolicyDesk, type GuardService, type GuardServiceOptions } from "./service.js";
import type { GuardStore } from "./store.js";
import { registerGuardSyncRoutes } from "./sync-routes.js";

export interface GuardWiring {
  store: GuardStore | undefined;
  signer: GuardSigner | undefined;
  orgs: GuardServiceOptions["orgs"];
  members: GuardServiceOptions["members"];
  groups?: GuardServiceOptions["groups"];
  policy?: () => GuardPolicyDesk | undefined;
  newOrg?: GuardServiceOptions["newOrg"];
  serverUrl: string;
  now: () => Date;
  audit?: (entry: GuardAuditEntry) => Promise<void>;
}

export const registerGuard = (app: FastifyInstance, wiring: GuardWiring): GuardService | undefined => {
  const guard =
    wiring.store === undefined || wiring.signer === undefined
      ? undefined
      : createGuardService({
          store: wiring.store,
          signer: wiring.signer,
          orgs: wiring.orgs,
          members: wiring.members,
          ...(wiring.groups === undefined ? {} : { groups: wiring.groups }),
          ...(wiring.policy === undefined ? {} : { policy: wiring.policy }),
          ...(wiring.newOrg === undefined ? {} : { newOrg: wiring.newOrg }),
          serverUrl: wiring.serverUrl,
          now: wiring.now,
          ...(wiring.audit === undefined ? {} : { audit: wiring.audit }),
        });
  registerGuardSyncRoutes(app, { guard });
  registerGuardConsoleRoutes(app, { guard });
  return guard;
};

export { registerGuardConsoleApp, defaultGuardConsoleDistDir } from "./app.js";
export type { GuardService } from "./service.js";
