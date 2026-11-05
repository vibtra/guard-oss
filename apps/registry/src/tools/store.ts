import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VibtraError } from "../errors.js";
import { ToolDatabaseLease } from "../vault/dynamic.js";
import type { StoredScope } from "../vault/scope.js";
import { emptyResealCounts, tallySealedRow, type ResealCounts, type VaultSealer } from "../vault/seal.js";
import { resealToolSecret } from "./secret.js";

export const OAUTH_CLIENT_ID_PATTERN = /^cli_[0-9a-f]{16}$/;

export const ToolVendorDeployment = z
  .object({
    provider: z.string().min(1),
    deploymentId: z.string().min(1),
    capturedAt: z.string().min(1),
    targetId: z.string().min(1).optional(),
    siteId: z.string().min(1).optional(),
  })
  .strict();
export type ToolVendorDeployment = z.infer<typeof ToolVendorDeployment>;

export const OrgToolRow = z.object({
  orgId: z.string().min(1),
  toolId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  ownerEmail: z.string().min(1),
  audienceKind: z.string().min(1),
  audienceSubjects: z.array(z.string().min(1)),
  oauthClientId: z.string().regex(OAUTH_CLIENT_ID_PATTERN),
  oauthClientSecretSealed: z.string().min(1),
  oauthKeyId: z.string().min(1),
  oauthRedirectUris: z.array(z.string().min(1)),
  databaseLeases: z.array(ToolDatabaseLease).optional(),
  vendorDeployment: ToolVendorDeployment.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrgToolRow = z.infer<typeof OrgToolRow>;

export interface UpsertToolOutcome {
  row: OrgToolRow;
  created: boolean;
}

export interface ToolStore {
  getTool(orgId: string, toolId: string): Promise<OrgToolRow | undefined>;
  findByClientId(oauthClientId: string): Promise<OrgToolRow | undefined>;
  upsertTool(row: OrgToolRow): Promise<UpsertToolOutcome>;
  setAudience(args: { orgId: string; toolId: string; audience: StoredScope; updatedAt: string }): Promise<boolean>;
  setOwner(args: { orgId: string; toolId: string; ownerEmail: string; updatedAt: string }): Promise<boolean>;
  setRedirectUris(args: { orgId: string; toolId: string; redirectUris: string[]; updatedAt: string }): Promise<boolean>;
  setDatabaseLeases(args: { orgId: string; toolId: string; leases: ToolDatabaseLease[] }): Promise<boolean>;
  setVendorDeployment(args: {
    orgId: string;
    toolId: string;
    vendorDeployment: ToolVendorDeployment;
  }): Promise<boolean>;
  listToolsWithDatabaseLeases(): Promise<OrgToolRow[]>;
  rotateClientSecret(args: {
    orgId: string;
    toolId: string;
    sealedSecret: string;
    keyId: string;
    updatedAt: string;
  }): Promise<boolean>;
  listTools(orgId: string): Promise<OrgToolRow[]>;
  resealAll(sealer: VaultSealer, options?: { dryRun?: boolean }): Promise<ResealCounts>;
}

const ToolsFile = z.object({ tools: z.array(OrgToolRow).default([]) });

export const createFileToolStore = async (file: string): Promise<ToolStore> => {
  let tools: OrgToolRow[] = [];
  try {
    tools = ToolsFile.parse(JSON.parse(await readFile(file, "utf8"))).tools;
  } catch {
  }

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ tools }, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    });
    return writeChain;
  };

  const find = (orgId: string, toolId: string): OrgToolRow | undefined =>
    tools.find((t) => t.orgId === orgId && t.toolId === toolId);

  return {
    async getTool(orgId, toolId) {
      const row = find(orgId, toolId);
      return row === undefined ? undefined : { ...row };
    },
    async findByClientId(oauthClientId) {
      const row = tools.find((t) => t.oauthClientId === oauthClientId);
      return row === undefined ? undefined : { ...row };
    },
    async upsertTool(row) {
      const parsed = OrgToolRow.parse(row);
      const existing = find(parsed.orgId, parsed.toolId);
      if (existing === undefined) {
        if (tools.some((t) => t.oauthClientId === parsed.oauthClientId)) {
          throw new VibtraError({
            code: "INTERNAL",
            message: "That OAuth client id is already taken",
            detail: `client id ${parsed.oauthClientId} is registered to another tool — mint a fresh one`,
          });
        }
        tools.push(parsed);
        await persist();
        return { row: { ...parsed }, created: true };
      }
      existing.name = parsed.name;
      existing.ownerEmail = existing.ownerEmail === "" ? parsed.ownerEmail : existing.ownerEmail;
      existing.audienceKind = parsed.audienceKind;
      existing.audienceSubjects = [...parsed.audienceSubjects];
      existing.updatedAt = parsed.updatedAt;
      await persist();
      return { row: { ...existing }, created: false };
    },
    async setAudience({ orgId, toolId, audience, updatedAt }) {
      const row = find(orgId, toolId);
      if (row === undefined) return false;
      row.audienceKind = audience.kind;
      row.audienceSubjects = [...audience.subjects];
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },
    async setOwner({ orgId, toolId, ownerEmail, updatedAt }) {
      const row = find(orgId, toolId);
      if (row === undefined) return false;
      row.ownerEmail = ownerEmail;
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },
    async setRedirectUris({ orgId, toolId, redirectUris, updatedAt }) {
      const row = find(orgId, toolId);
      if (row === undefined) return false;
      row.oauthRedirectUris = [...new Set(redirectUris)];
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },
    async rotateClientSecret({ orgId, toolId, sealedSecret, keyId, updatedAt }) {
      const row = find(orgId, toolId);
      if (row === undefined) return false;
      row.oauthClientSecretSealed = sealedSecret;
      row.oauthKeyId = keyId;
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },
    async setDatabaseLeases({ orgId, toolId, leases }) {
      const row = find(orgId, toolId);
      if (row === undefined) return false;
      row.databaseLeases = leases.map((lease) => ToolDatabaseLease.parse(lease));
      await persist();
      return true;
    },
    async setVendorDeployment({ orgId, toolId, vendorDeployment }) {
      const row = find(orgId, toolId);
      if (row === undefined) return false;
      row.vendorDeployment = ToolVendorDeployment.parse(vendorDeployment);
      await persist();
      return true;
    },
    async listToolsWithDatabaseLeases() {
      return tools.filter((t) => (t.databaseLeases ?? []).length > 0).map((t) => ({ ...t }));
    },
    async listTools(orgId) {
      return tools.filter((t) => t.orgId === orgId).map((t) => ({ ...t }));
    },
    async resealAll(sealer, options) {
      const counts = emptyResealCounts();
      const dryRun = options?.dryRun === true;
      let written = 0;
      for (const row of tools) {
        if (!(await tallySealedRow(counts, sealer, row.oauthClientSecretSealed))) continue;
        if (dryRun) continue;
        row.oauthClientSecretSealed = await resealToolSecret(sealer, row.orgId, row.toolId, row.oauthClientSecretSealed);
        row.oauthKeyId = sealer.keyId;
        written += 1;
      }
      if (written > 0) await persist();
      return counts;
    },
  };
};
