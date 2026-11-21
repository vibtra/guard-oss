import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REGISTRY_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "registry", "src");

interface MemberWriteRule {
  name: string;
  pattern: RegExp;
  allowed: readonly string[];
  instead: string;
}

const RULES: readonly MemberWriteRule[] = [
  {
    name: "SQL insert into the member table",
    pattern: /INSERT\s+INTO\s+"?member"?\s*\(/i,
    allowed: ["tenancy/admissions.ts"],
    instead: "admit people through claimInvitation or applyOrgPlan in tenancy/claim.ts, which hold the per-org lock",
  },
  {
    name: "adapter create on the member model",
    pattern: /\.create\s*(?:<[^>]*>)?\(\s*\{\s*model:\s*["']member["']/,
    allowed: ["tenancy/members.ts", "tenancy/admissions.ts"],
    instead: "admit people through claimInvitation or applyOrgPlan in tenancy/claim.ts, which hold the per-org lock",
  },
  {
    name: "MemberDirectory.addMember call",
    pattern: /\bmembers\.addMember\(/,
    allowed: ["tenancy/claim.ts"],
    instead: "call applyOrgPlan or claimInvitation in tenancy/claim.ts, so the seat check and the insert share the claim:join:<orgId> lock",
  },
  {
    name: "Better Auth addMember or acceptInvitation call",
    pattern: /\bapi\.(?:addMember|acceptInvitation)\(/,
    allowed: [],
    instead: "Better Auth's member writes skip Guard's per-org lock; use claimInvitation or applyOrgPlan in tenancy/claim.ts",
  },
];

const sourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(?:ts|mts|js|mjs)$/.test(entry.name) ? [full] : [];
    }),
  );
  return nested.flat();
};

const violations = (files: ReadonlyMap<string, string>): string[] =>
  RULES.flatMap((rule) =>
    [...files]
      .filter(([file, text]) => rule.pattern.test(text) && !rule.allowed.includes(file))
      .map(([file]) => `${file}: ${rule.name} outside ${rule.allowed.join(", ") || "any file"}. Instead, ${rule.instead}.`),
  );

describe("member rows are written only under the per-org admission lock", () => {
  it("fires on each kind of member write outside the admission modules", () => {
    const fixture = new Map([
      ["console-api/people.ts", `await pool.query('INSERT INTO "member" ("id") VALUES ($1)', [id]);`],
      ["scim/routes.ts", `await adapter.create<MemberRecord>({ model: "member", data });`],
      ["onboarding/service.ts", "await ctx.members.addMember({ orgId, userId, role });"],
      ["console-api/groups.ts", "await auth.auth.api.addMember({ body });"],
      ["tenancy/claim.ts", "await ctx.members.addMember({ orgId, userId, role });"],
      ["tenancy/admissions.ts", `INSERT INTO "member" ("id") VALUES ($1)`],
    ]);
    expect(violations(fixture)).toEqual([
      expect.stringMatching(/^console-api\/people\.ts: SQL insert into the member table outside tenancy\/admissions\.ts\. Instead, admit people through claimInvitation/),
      expect.stringMatching(/^scim\/routes\.ts: adapter create on the member model/),
      expect.stringMatching(/^onboarding\/service\.ts: MemberDirectory\.addMember call outside tenancy\/claim\.ts/),
      expect.stringMatching(/^console-api\/groups\.ts: Better Auth addMember or acceptInvitation call outside any file/),
    ]);
  });

  it("finds no member write outside the admission modules in this tree", async () => {
    const files = new Map<string, string>();
    for (const file of await sourceFiles(REGISTRY_SRC)) {
      files.set(path.relative(REGISTRY_SRC, file).split(path.sep).join("/"), await readFile(file, "utf8"));
    }
    expect(files.size).toBeGreaterThan(50);
    expect(violations(files)).toEqual([]);
    for (const rule of RULES) for (const allowed of rule.allowed) expect(files.has(allowed), `${rule.name}: ${allowed} no longer exists`).toBe(true);
  });
});
