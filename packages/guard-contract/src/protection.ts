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

interface OffSpan {
  mode: GuardClientMode;
  offSince?: string | undefined;
  offUntil?: string | undefined;
}

export const offSpanAfter = (was: OffSpan, mode: GuardClientMode, at: string): Pick<OffSpan, "offSince" | "offUntil"> => {
  const since = was.offSince === undefined ? {} : { offSince: was.offSince };
  if (mode === "off") return was.mode === "off" ? since : { offSince: at };
  if (was.mode === "off") return { ...since, offUntil: at };
  return { ...since, ...(was.offUntil === undefined ? {} : { offUntil: was.offUntil }) };
};

export const wasOffAt = (span: OffSpan, at: string): boolean =>
  (span.offSince === undefined || at >= span.offSince) && (span.mode === "off" || (span.offUntil !== undefined && at < span.offUntil));
