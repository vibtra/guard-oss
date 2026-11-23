import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GuardSettings } from "@vibtra/guard-contract";
import type { GuardStore } from "@vibtra/registry/src/guard/store.ts";
import type { Admissions } from "@vibtra/registry/src/tenancy/admissions.ts";
import { refuseIfOrgIsFull, type ClaimContext } from "@vibtra/registry/src/tenancy/claim.ts";
import { required } from "./guard-device.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");

const preFixShapes = {
  async f533a2f(ctx: ClaimContext, orgId: string, userId: string, email: string) {
    await refuseIfOrgIsFull(ctx, required(await ctx.orgs.getOrg(orgId), "the org"), email);
    // @ts-expect-error f533a2f: the seat check ran in a Better Auth hook and the member insert came after it, outside the org lock
    await ctx.admissions.admit(orgId, { kind: "member", userId, role: "member", at: new Date() }, { seats: () => undefined });
  },

  async a773c79StaleWriteBack(store: GuardStore, orgId: string) {
    const stale = required(await store.getSettings(orgId), "the settings");
    // @ts-expect-error a773c79: apply wrote back a settings blob it had read before the write, outside the org lock
    await store.saveSettings(orgId, { fallback: GuardSettings.parse({}), update: () => ({ ...stale.settings, clientMode: "enforce" }), by: "admin@example.com", at: new Date().toISOString() });
  },

  async a773c79PlanFromUnlockedRead(store: GuardStore, admissions: Admissions, orgId: string) {
    // @ts-expect-error a773c79: apply planned from a protection read taken outside the org lock, so its revision check could pass on a stale plan
    const protection = await store.getOrgProtection(orgId);
    // @ts-expect-error a773c79: apply planned from a member list read outside the org lock, so it moved people who joined after the preview
    const members = await admissions.members(orgId);
    return { protection, members };
  },
};

describe("org state is written only under withOrgLock", () => {
  it("refuses to compile each past mistake's call shape, and every refusal names withOrgLock", async () => {
    const self = fileURLToPath(import.meta.url);
    const stripped = path.join(HERE, `.org-locked-tx-${process.pid}.ts`);
    const tsconfig = path.join(HERE, `.org-locked-tx-${process.pid}.tsconfig.json`);
    const source = await readFile(self, "utf8");
    const directives = source.split("\n").filter((line) => line.trim().startsWith("// @ts-expect-error")).length;
    try {
      await writeFile(stripped, source.split("\n").filter((line) => !line.trim().startsWith("// @ts-expect-error")).join("\n"));
      await writeFile(tsconfig, JSON.stringify({ extends: "../../tsconfig.json", include: [], files: [path.basename(stripped)] }));
      const run = spawnSync(path.join(REPO, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", tsconfig], { cwd: REPO, encoding: "utf8" });
      const errors = `${run.stdout}${run.stderr}`.split(/\n(?=\S)/).filter((block) => block.includes(path.basename(stripped)));
      expect(Object.keys(preFixShapes)).toHaveLength(3);
      expect(errors, `${run.stdout}${run.stderr}`).toHaveLength(directives);
      for (const error of errors) expect(error).toContain("[withOrgLock]");
    } finally {
      await rm(stripped, { force: true });
      await rm(tsconfig, { force: true });
    }
  });
});
