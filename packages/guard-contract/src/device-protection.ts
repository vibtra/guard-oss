// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";
import type { GuardClientMode } from "./bundle.js";
import { GuardInterceptionOffReason } from "./sync.js";

export interface GuardDeviceProtectionFacts {
  status: "active" | "revoked";
  interception: "on" | "not-reported" | GuardInterceptionOffReason;
  extension: "active" | "not-active";
  silence: "fresh" | "late" | "quiet";
  policy: "applied" | "no-policy" | "sync-failing";
  mode: GuardClientMode;
}

const Named = z.object({ state: z.enum(["revoked", "quiet", "late", "no-policy", "sync-failing", "monitoring", "off"]) }).strict();
const Unprotected = z.object({ state: z.literal("unprotected"), reason: z.union([GuardInterceptionOffReason, z.enum(["interception-not-reported", "extension-not-active"])]) }).strict();
type NotProtected = z.infer<typeof Named> | z.infer<typeof Unprotected>;

export const GuardDeviceProtection = z.union([z.object({ state: z.literal("protected") }).strict(), Named, Unprotected]);
export type GuardDeviceProtection = z.infer<typeof GuardDeviceProtection>;

const RUNNING: Readonly<Record<Exclude<GuardClientMode, "enforce">, NotProtected>> = { monitor: { state: "monitoring" }, off: { state: "off" } };

const notProtected = ({ status, interception, silence, policy, mode }: GuardDeviceProtectionFacts): NotProtected => {
  if (status === "revoked") return { state: "revoked" };
  if (interception !== "on" && interception !== "not-reported") return { state: "unprotected", reason: interception };
  if (silence !== "fresh") return { state: silence };
  if (policy !== "applied") return { state: policy };
  if (mode !== "enforce") return RUNNING[mode];
  return { state: "unprotected", reason: interception === "on" ? "extension-not-active" : "interception-not-reported" };
};

export const deviceProtectionOf = (facts: GuardDeviceProtectionFacts): GuardDeviceProtection => {
  const { status, interception, extension, silence, policy, mode } = facts;
  if (status === "active" && interception === "on" && extension === "active" && silence === "fresh" && policy === "applied" && mode === "enforce") return { state: "protected" };
  return notProtected(facts);
};
