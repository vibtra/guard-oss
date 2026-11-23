import { emptyGuardRules } from "@vibtra/guard-contract";
import type { GuardSigner } from "@vibtra/guard-contract/signing";
import type { FastifyInstance } from "fastify";
import { registerGuardConsoleRoutes } from "./console-routes.js";
import { createGuardWaits, type GuardWaits } from "./long-poll.js";
import type { GuardNoticeFeed } from "./policy-notices.js";
import { createGuardService, type GuardAuditEntry, type GuardPolicyDesk, type GuardService, type GuardServiceOptions } from "./service.js";
import type { GuardStore } from "./store.js";
import type { OrgLockedTx } from "../store/org-lock.js";
import { registerGuardSyncRoutes } from "./sync-routes.js";

export interface GuardWiring {
  store: GuardStore | undefined;
  signer: GuardSigner | undefined;
  orgs: GuardServiceOptions["orgs"];
  members: GuardServiceOptions["members"];
  locks: GuardServiceOptions["locks"];
  lockedMembers: GuardServiceOptions["lockedMembers"];
  groups?: GuardServiceOptions["groups"];
  policy?: () => GuardPolicyDesk | undefined;
  newOrg?: GuardServiceOptions["newOrg"];
  serverUrl: string;
  now: () => Date;
  audit?: (entry: GuardAuditEntry, tx?: OrgLockedTx) => Promise<void>;
  notices?: GuardNoticeFeed;
}

const waitsFor = (app: FastifyInstance, store: GuardStore, notices: GuardNoticeFeed, newOrg: GuardWiring["newOrg"]): GuardWaits => {
  const unsavedRules = (newOrg?.rules ?? emptyGuardRules()).version;
  const waits = createGuardWaits({
    feed: notices,
    load: async (orgId, userIds) => {
      const read = await store.readStamps(orgId, userIds);
      return new Map(userIds.map((userId) => [userId, { rules: read.rulesVersion ?? unsavedRules, revision: read.revisions[userId] ?? 0 }] as const));
    },
    log: app.log,
  });
  app.addHook("onReady", async () => waits.start());
  app.addHook("preClose", async () => waits.close());
  return waits;
};

export const registerGuard = (app: FastifyInstance, wiring: GuardWiring): GuardService | undefined => {
  const guard =
    wiring.store === undefined || wiring.signer === undefined
      ? undefined
      : createGuardService({
          store: wiring.store,
          signer: wiring.signer,
          orgs: wiring.orgs,
          members: wiring.members,
          locks: wiring.locks,
          lockedMembers: wiring.lockedMembers,
          ...(wiring.groups === undefined ? {} : { groups: wiring.groups }),
          ...(wiring.policy === undefined ? {} : { policy: wiring.policy }),
          ...(wiring.newOrg === undefined ? {} : { newOrg: wiring.newOrg }),
          serverUrl: wiring.serverUrl,
          now: wiring.now,
          ...(wiring.audit === undefined ? {} : { audit: wiring.audit }),
        });
  const waits = guard === undefined || wiring.store === undefined || wiring.notices === undefined ? undefined : waitsFor(app, wiring.store, wiring.notices, wiring.newOrg);
  registerGuardSyncRoutes(app, { guard, waits });
  registerGuardConsoleRoutes(app, { guard });
  return guard;
};

export { registerGuardConsoleApp, defaultGuardConsoleDistDir } from "./app.js";
export type { GuardService } from "./service.js";
