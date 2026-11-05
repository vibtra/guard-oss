import crypto from "node:crypto";
import type { VaultAuditRow, VaultStore } from "./store.js";

const newAuditId = (): string => `vau_${crypto.randomBytes(8).toString("hex")}`;

export const appendVaultAudit = async (
  vault: VaultStore,
  row: Omit<VaultAuditRow, "auditId" | "at">,
  at: string = new Date().toISOString(),
): Promise<void> => {
  await vault.appendAudit({ auditId: newAuditId(), at, ...row });
};
