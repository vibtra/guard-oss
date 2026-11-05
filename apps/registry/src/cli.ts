// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import { gateSigningSecretFor, loadRegistryConfig, type RegistryConfig } from "./config.js";
import { formatIssuerRotation, rotateIssuerKey } from "./issuer/rotate.js";
import {
  approvePlanChangeRequest,
  changeOrgLimit,
  changeOrgPlan,
  declinePlanChangeRequest,
} from "./tenancy/plan-changes.js";
import { setDesignPartner } from "./tenancy/design-partner.js";
import type { RegistryEnterprise } from "./enterprise.js";
import { createRegistryServer, DEFAULT_REGISTRY_PORT } from "./server.js";
import type { RegistryService } from "./service.js";
import {
  formatRotationLine,
  type ResealCounts,
  type RotationCensus,
  type VaultSealer,
} from "./vault/seal.js";
import { createOrgVaultSealer } from "./vault/sealer-ring.js";
import { resealSsoProviders } from "./auth/sso-secret.js";

const mustWalk = async (
  store: { resealAll(sealer: VaultSealer, options?: { dryRun?: boolean }): Promise<ResealCounts> } | undefined,
  what: string,
  sealer: VaultSealer,
): Promise<ResealCounts> => {
  if (store === undefined) {
    throw new Error(`this configuration built no ${what}, so its rows cannot be counted — refusing to report a total over a store that was never opened`);
  }
  return store.resealAll(sealer, { dryRun: true });
};

const bootConfig = (): RegistryConfig => loadRegistryConfig(process.env, (line) => console.error(line));

const census = async (service: RegistryService, sealer: VaultSealer): Promise<RotationCensus> => ({
  connections: await mustWalk(service.vault, "org vault", sealer),
  tools: await mustWalk(service.tools, "tool store", sealer),
});

const sealerFor = (config: RegistryConfig): VaultSealer | undefined =>
  createOrgVaultSealer(config.hosted ?? {});

const logRotationCensus = async (config: RegistryConfig, service: RegistryService): Promise<void> => {
  const sealer = sealerFor(config);
  if (sealer === undefined) return;
  try {
    console.log(`[vibtra-registry] ${formatRotationLine(await census(service, sealer), sealer.keyIds)}`);
  } catch (e) {
    console.warn(`[vibtra-registry] vault key ring: census unavailable — ${e instanceof Error ? e.message : String(e)}`);
  }
};

const serve = async (options: RegistryCliOptions): Promise<void> => {
  const port = Number(process.env.PORT ?? DEFAULT_REGISTRY_PORT);
  const host = process.env.HOST ?? "127.0.0.1";
  const config = bootConfig();
  const registry = await createRegistryServer({
    port,
    config,
    logger: true,
    ...(options.enterprise === undefined ? {} : { enterprise: options.enterprise }),
  });
  console.log(`[vibtra-registry] ${enterprisePostureLine(options.enterprise)}`);
  await logRotationCensus(config, registry.service);
  await registry.app.listen({ port, host });
};

const reseal = async (): Promise<number> => {
  const config = bootConfig();
  if (config.mode !== "hosted") {
    console.error("[vibtra-registry] reseal: nothing to do — the org vault exists only in hosted mode (REGISTRY_MODE=hosted).");
    return 1;
  }
  const sealer = sealerFor(config);
  if (sealer === undefined) {
    console.error(
      "[vibtra-registry] reseal: this registry has no current vault key. Either set VIBTRA_VAULT_KEY to the key you " +
        "are rotating TO and put the old key in VIBTRA_VAULT_KEY_PREVIOUS (apps/registry/README.md, \"Rotating the " +
        "vault key\"), or set OPENBAO_ADDR with its AppRole to make OpenBao's transit engine the current key and " +
        "migrate every row onto it (docs/openbao.md). Then run this again.",
    );
    return 1;
  }
  const registry = await createRegistryServer({ config, logger: false });
  try {
    const storage = config.databaseUrl === undefined || config.databaseUrl === "" ? "file store" : "postgres";
    console.log(`[vibtra-registry] reseal — storage: ${storage}`);
    console.log(`[vibtra-registry] ${formatRotationLine(await census(registry.service, sealer), sealer.keyIds)}`);

    const { vault, tools: toolStore } = registry.service;
    if (vault === undefined || toolStore === undefined) {
      console.error(
        "[vibtra-registry] reseal: this configuration built no org vault or no tool store, so there is nothing to " +
          "walk — refusing to report a rotation over stores this command never opened. Check REGISTRY_MODE and " +
          "VIBTRA_REGISTRY_DATA_DIR / DATABASE_URL.",
      );
      return 1;
    }
    const connections = await vault.resealAll(sealer);
    const tools = await toolStore.resealAll(sealer);
    const ssoAuth = registry.auth;
    const ssoProviders =
      ssoAuth === undefined ? undefined : await resealSsoProviders(await ssoAuth.storedAdapter(), sealer);
    for (const [what, counts] of [
      ["connection credentials", connections],
      ["tool secrets", tools],
      ...(ssoProviders === undefined ? [] : ([["SSO client secrets", ssoProviders]] as const)),
    ] as const) {
      console.log(
        `[vibtra-registry] ${what}: ${counts.scanned} scanned, ${counts.stale} re-sealed, ` +
          `${counts.current} already current, ${counts.unreadable} unreadable`,
      );
    }

    if (ssoProviders === undefined) {
      console.log(
        "[vibtra-registry] SSO client secrets: not walked — this registry built no sign-in, so it has no " +
          "`ssoProvider` table (migration 0033).",
      );
    }

    const after = await census(registry.service, sealer);
    console.log(`[vibtra-registry] verification: ${formatRotationLine(after, sealer.keyIds)}`);
    const ssoAfter =
      ssoAuth === undefined
        ? undefined
        : await resealSsoProviders(await ssoAuth.storedAdapter(), sealer, { dryRun: true });
    if (ssoAfter !== undefined) {
      console.log(
        `[vibtra-registry] verification: SSO client secrets — ${ssoAfter.scanned} scanned, ` +
          `${ssoAfter.stale} still to re-seal, ${ssoAfter.current} already current, ${ssoAfter.unreadable} unreadable`,
      );
    }
    if ((ssoAfter?.stale ?? 0) + (ssoAfter?.unreadable ?? 0) > 0) {
      console.error(
        "[vibtra-registry] reseal: NOT complete — one or more SSO client secrets are still not under the current " +
          "key. Leave VIBTRA_VAULT_KEY_PREVIOUS as it is; a row naming a key this registry does not hold needs that " +
          "key added to the list, or the organisation's owner has to remove and re-add their sign-in provider.",
      );
      return 1;
    }
    if (
      after.connections.stale + after.tools.stale > 0 ||
      after.connections.unreadable + after.tools.unreadable > 0
    ) {
      console.error(
        "[vibtra-registry] reseal: NOT complete — the rows above are still not under the current key. Leave " +
          "VIBTRA_VAULT_KEY_PREVIOUS as it is; a row naming a key this registry does not hold needs that key added " +
          "to the list, or the credential re-entered by an admin.",
      );
      return 1;
    }
    console.log(
      "[vibtra-registry] reseal: complete — every sealed row is under the current key. You can now remove the old " +
        "key from VIBTRA_VAULT_KEY_PREVIOUS and restart" +
        (config.hosted?.openbaoAddr === undefined
          ? "."
          :
            " — including VIBTRA_VAULT_KEY itself, now that OpenBao holds every row's key and no row is left under a " +
              "previous one."),
    );
    return 0;
  } finally {
    await registry.app.close();
  }
};

const planCommand = async (argv: string[]): Promise<number> => {
  const actorFlag = argv.find((a) => a.startsWith("--actor="));
  const rest = argv.filter((a) => a !== "--" && !a.startsWith("--actor="));
  const [orgId, what, value] = rest;
  const actor = actorFlag?.slice("--actor=".length).trim() ?? "";
  const usage =
    'usage: pnpm --filter @vibtra/registry plan -- <orgId> plan <planId> --actor=<your address>\n' +
    "       pnpm --filter @vibtra/registry plan -- <orgId> users|connections <number|plan> --actor=<your address>\n" +
    "       pnpm --filter @vibtra/registry plan -- <orgId> design-partner <ISO date|none> --actor=<your address>";
  if (orgId === undefined || what === undefined || value === undefined || rest.length > 3) {
    console.error(`[vibtra-registry] plan: ${usage}`);
    return 1;
  }
  if (actor === "") {
    console.error(
      "[vibtra-registry] plan: --actor=<your address> is required. This change is written to the org's audit log " +
        'and the log has to name somebody — "whoever had shell access" is not an answer to "who did this".',
    );
    return 1;
  }
  const config = bootConfig();
  if (config.mode !== "hosted") {
    console.error("[vibtra-registry] plan: nothing to do — plans exist only in hosted mode (REGISTRY_MODE=hosted).");
    return 1;
  }
  const registry = await createRegistryServer({ config, logger: false });
  try {
    const tenancy = registry.service.tenancy;
    if (tenancy === undefined) {
      console.error(
        "[vibtra-registry] plan: this configuration built no tenancy store, so there is no org row to change.",
      );
      return 1;
    }
    const ctx = { tenancy, vault: registry.service.vault };
    let result;
    if (what === "plan") {
      result = await changeOrgPlan(ctx, { orgId, plan: value, actor });
    } else if (what === "users" || what === "connections") {
      const limit = value === "plan" ? undefined : Number(value);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        console.error(
          `[vibtra-registry] plan: ${JSON.stringify(value)} is not a limit — give a non-negative whole number, or ` +
            "the word `plan` to clear the override.",
        );
        return 1;
      }
      result = await changeOrgLimit(ctx, { orgId, kind: what, limit, actor });
    } else if (what === "design-partner") {
      const outcome = await setDesignPartner(ctx, {
        orgId,
        ...(value === "none" ? { until: undefined } : { until: value }),
        actor,
      });
      result = {
        orgId: outcome.orgId,
        orgName: outcome.orgName,
        previous: outcome.previous === undefined ? "none" : `${outcome.previous.discountPct}% until ${outcome.previous.until}`,
        next: outcome.next === undefined ? "none" : `${outcome.next.discountPct}% until ${outcome.next.until}`,
        audited: outcome.audited,
      };
    } else {
      console.error(`[vibtra-registry] plan: unknown field ${JSON.stringify(what)}.\n${usage}`);
      return 1;
    }
    console.log(
      `[vibtra-registry] ${result.orgName} (${result.orgId}): ${result.previous} → ${result.next}, by ${actor}` +
        (result.audited
          ? " — written to this org's audit log."
          : " — NOT written to an audit log: this configuration built no vault."),
    );
    return 0;
  } catch (e) {
    console.error(`[vibtra-registry] plan: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await registry.app.close();
  }
};

const planRequestsCommand = async (argv: string[]): Promise<number> => {
  const actorFlag = argv.find((a) => a.startsWith("--actor="));
  const noteFlag = argv.find((a) => a.startsWith("--note="));
  const rest = argv.filter((a) => a !== "--" && !a.startsWith("--actor=") && !a.startsWith("--note="));
  const [verb, requestId] = rest;
  const actor = actorFlag?.slice("--actor=".length).trim() ?? "";
  const note = noteFlag?.slice("--note=".length).trim();
  const usage =
    "usage: pnpm --filter @vibtra/registry plan-requests -- list\n" +
    "       pnpm --filter @vibtra/registry plan-requests -- approve <requestId> --actor=<your address> [--note=…]\n" +
    "       pnpm --filter @vibtra/registry plan-requests -- decline <requestId> --actor=<your address> [--note=…]";

  if (verb !== "list" && verb !== "approve" && verb !== "decline") {
    console.error(`[vibtra-registry] plan-requests: ${usage}`);
    return 1;
  }
  if (verb !== "list" && (requestId === undefined || rest.length > 2)) {
    console.error(`[vibtra-registry] plan-requests: ${usage}`);
    return 1;
  }
  if (verb !== "list" && actor === "") {
    console.error(
      "[vibtra-registry] plan-requests: --actor=<your address> is required. Deciding a plan-change request moves " +
        'a customer between buckets and is written to that org\'s audit log — "whoever had shell access" is not ' +
        'an answer to "who did this".',
    );
    return 1;
  }

  const config = loadRegistryConfig(process.env);
  if (config.mode !== "hosted") {
    console.error(
      "[vibtra-registry] plan-requests: nothing to do — plans exist only in hosted mode (REGISTRY_MODE=hosted).",
    );
    return 1;
  }
  const registry = await createRegistryServer({ config, logger: false });
  try {
    const tenancy = registry.service.tenancy;
    const planRequests = registry.service.planRequests;
    if (tenancy === undefined || planRequests === undefined) {
      console.error(
        "[vibtra-registry] plan-requests: this configuration built no plan-change queue, so there is nothing to " +
          "decide.",
      );
      return 1;
    }
    const ctx = { tenancy, vault: registry.service.vault, planRequests };

    if (verb === "list") {
      const open = await planRequests.listOpen();
      if (open.length === 0) {
        console.log("[vibtra-registry] plan-requests: nothing is waiting.");
        return 0;
      }
      for (const row of open) {
        const org = await tenancy.getOrg(row.orgId);
        console.log(
          `[vibtra-registry] ${row.requestId}  ${org?.name ?? row.orgId} (${row.orgId})  ` +
            `${row.currentPlan} → ${row.wantedPlan}  asked by ${row.requesterEmail} at ${row.createdAt}` +
            (row.note === undefined ? "" : `\n                  note: ${row.note}`),
        );
      }
      console.log(`[vibtra-registry] plan-requests: ${open.length} waiting.`);
      return 0;
    }

    const outcome =
      verb === "approve"
        ? await approvePlanChangeRequest(ctx, { requestId: requestId as string, actor, ...(note === undefined || note === "" ? {} : { note }) })
        : await declinePlanChangeRequest(ctx, { requestId: requestId as string, actor, ...(note === undefined || note === "" ? {} : { note }) });

    if (verb === "decline") {
      console.log(
        `[vibtra-registry] ${outcome.orgName} (${outcome.request.orgId}): request ${outcome.request.requestId} ` +
          `DECLINED by ${actor} — the plan is unchanged (${outcome.previous}). They may ask again.`,
      );
      return 0;
    }
    console.log(
      `[vibtra-registry] ${outcome.orgName} (${outcome.request.orgId}): request ${outcome.request.requestId} ` +
        `APPROVED by ${actor}` +
        (outcome.moved
          ? ` — ${outcome.previous} → ${outcome.next}` +
            (outcome.audited
              ? ", written to this org's audit log."
              : ", NOT written to an audit log: this configuration built no vault.")
          : ` — the org was already on ${outcome.next}, so nothing was changed and nothing was audited.`),
    );
    return 0;
  } catch (e) {
    console.error(`[vibtra-registry] plan-requests: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await registry.app.close();
  }
};

const rotateIssuerKeyCommand = async (argv: string[]): Promise<number> => {
  const revoke = argv.includes("--revoke");
  const unknown = argv.filter((arg) => arg !== "--revoke" && arg !== "--");
  if (unknown.length > 0) {
    console.error(
      `[vibtra-registry] rotate-issuer-key: unknown argument ${JSON.stringify(unknown[0])} — the only flag is ` +
        "--revoke (sign every live artifact out now, instead of letting tokens already issued run to their exp).",
    );
    return 1;
  }
  const config = bootConfig();
  if (config.mode !== "hosted") {
    console.error(
      "[vibtra-registry] rotate-issuer-key: nothing to do — the tool-gate issuer exists only in hosted mode " +
        "(REGISTRY_MODE=hosted). A single-tenant registry signs nobody into anything and has no `jwks` table.",
    );
    return 1;
  }
  const hosted = config.hosted;
  const baseUrl = hosted?.baseUrl;
  if (hosted === undefined || baseUrl === undefined || baseUrl === "") {
    console.error("[vibtra-registry] rotate-issuer-key: hosted mode with no REGISTRY_BASE_URL — see apps/registry/README.md.");
    return 1;
  }
  if (config.databaseUrl === undefined || config.databaseUrl === "") {
    console.error(
      "[vibtra-registry] rotate-issuer-key: this registry has no DATABASE_URL, so its signing key lives in the " +
        "serving process's memory (Better Auth's in-memory adapter) rather than in a `jwks` table. A rotation run " +
        "here would mint a key into THIS process and exit, changing nothing for the registry that is actually " +
        "serving. Refusing. On a dev box, restarting the registry already mints a fresh key and signs everyone out, " +
        "which is the same blunt outcome --revoke gives you.",
    );
    return 1;
  }
  const registry = await createRegistryServer({ config, logger: false });
  try {
    console.log(`[vibtra-registry] rotate-issuer-key — issuer: ${baseUrl}, storage: postgres, mode: ${revoke ? "REVOKE (sign everyone out now)" : "soft (nobody is signed out)"}`);
    const rotation = await rotateIssuerKey(registry, {
      baseUrl,
      gateSigningSecret: gateSigningSecretFor(hosted),
      revoke,
    });
    for (const line of formatIssuerRotation(rotation)) console.log(`[vibtra-registry] ${line}`);
    console.log(
      "[vibtra-registry] rotate-issuer-key: complete — no redeploy is needed. Every deployed gate verifies through " +
        "jose's createRemoteJWKSet, which refetches the key set the first time it meets a kid it does not hold.",
    );
    return 0;
  } finally {
    await registry.app.close();
  }
};

export interface RegistryCliOptions {
  enterprise?: RegistryEnterprise;
}

const enterprisePostureLine = (enterprise: RegistryEnterprise | undefined): string => {
  if (enterprise === undefined) return "enterprise (ee/): not loaded — the AGPL core; enterprise features answer that they are not enabled";
  const { status } = enterprise;
  return status.licensed
    ? `enterprise (ee/): licensed to ${status.licensee ?? "?"} until ${status.expiresAt ?? "?"} — ${status.features.join(", ") || "no features"}`
    : `enterprise (ee/): loaded, NOT licensed — ${status.reason ?? "no reason given"}; enterprise features answer that they are not enabled`;
};

export const runRegistryCli = async (options: RegistryCliOptions = {}): Promise<void> => {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") return serve(options);
  if (command === "reseal") {
    process.exitCode = await reseal();
    return;
  }
  if (command === "rotate-issuer-key") {
    process.exitCode = await rotateIssuerKeyCommand(process.argv.slice(3));
    return;
  }
  if (command === "plan") {
    process.exitCode = await planCommand(process.argv.slice(3));
    return;
  }
  if (command === "plan-requests") {
    process.exitCode = await planRequestsCommand(process.argv.slice(3));
    return;
  }
  console.error(
    `[vibtra-registry] unknown command ${JSON.stringify(command)} — expected "serve" (the default), "reseal", ` +
      `"rotate-issuer-key", "plan" or "plan-requests".`,
  );
  process.exitCode = 1;
};
