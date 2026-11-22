// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { GuardClientMode } from "./bundle.js";

const GUARD_MODE_RANK: Readonly<Record<GuardClientMode, number>> = { off: 0, monitor: 1, enforce: 2 };

const GUARD_POLICY_TTL_SECONDS = 72 * 60 * 60;

export const raiseMode = (a: GuardClientMode, b: GuardClientMode): GuardClientMode => (GUARD_MODE_RANK[b] > GUARD_MODE_RANK[a] ? b : a);

export const modeOrEnforce = (value: unknown): GuardClientMode => {
  const parsed = GuardClientMode.safeParse(value);
  return parsed.success ? parsed.data : "enforce";
};

export const effectiveMode = (row: { mode: GuardClientMode } | undefined, orgDefault: GuardClientMode): { mode: GuardClientMode; source: "set" | "default" } =>
  row === undefined ? { mode: orgDefault, source: "default" } : { mode: row.mode, source: "set" };

export const policyValidUntil = (iat: number): number => iat + GUARD_POLICY_TTL_SECONDS;
