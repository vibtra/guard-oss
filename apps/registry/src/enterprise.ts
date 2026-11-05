// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra

import type { OrgMemberRow } from "./tenancy/members.js";

export const ENTERPRISE_FEATURES = [
  "scim",
  "saml",
  "groupPolicies",
  "siemExport",
  "auditRetention",
  "multiStepApprovals",
  "multiOrg",
] as const;
export type EnterpriseFeatureId = (typeof ENTERPRISE_FEATURES)[number];

export const ENTERPRISE_FEATURE_NAMES: Record<EnterpriseFeatureId, string> = {
  scim: "Directory sync (SCIM)",
  saml: "SAML single sign-on",
  groupPolicies: "Group policies",
  siemExport: "SIEM export",
  auditRetention: "Long audit retention and export",
  multiStepApprovals: "Multi-step approvals",
  multiOrg: "Multiple organisations",
};

export type EnterpriseAvailability = { ok: true } | { ok: false; reason: string };

export interface EnterpriseStatus {
  licensed: boolean;
  licensee?: string;
  expiresAt?: string;
  features: EnterpriseFeatureId[];
  reason?: string;
}

export interface ScimAuthAdapter {
  findMany<T>(data: {
    model: string;
    where?: Array<{ field: string; value: string; operator?: "eq" }>;
    limit?: number;
    sortBy?: { field: string; direction: "asc" | "desc" };
  }): Promise<T[]>;
  delete<T>(data: { model: string; where: Array<{ field: string; value: string; operator?: "eq" }> }): Promise<void>;
}

export interface ScimDirectoryContext {
  directory: { listMembers(orgId: string): Promise<OrgMemberRow[]> };
  authAdapter: () => Promise<ScimAuthAdapter>;
  baseUrl: string;
}

export type ScimOutcome =
  | { status: 200; body: unknown; log?: Record<string, unknown> }
  | { status: 400 | 404; error: string; scimType?: string };

export interface ScimDirectorySync {
  listUsers(orgId: string, query: { filter?: string; startIndex?: string; count?: string }): Promise<ScimOutcome>;
  getUser(orgId: string, userId: string): Promise<ScimOutcome>;
  patchUser(orgId: string, userId: string, body: unknown): Promise<ScimOutcome>;
}

export interface RegistryEnterprise {
  status: EnterpriseStatus;
  available(feature: EnterpriseFeatureId): EnterpriseAvailability;
  scim?: (ctx: ScimDirectoryContext) => ScimDirectorySync;
}

export const enterpriseUnavailable = (feature: EnterpriseFeatureId, reason?: string): string =>
  `${ENTERPRISE_FEATURE_NAMES[feature]} is a Vibtra Enterprise feature (ee/), and it is not enabled on this ` +
  `deployment: ${reason ?? "the registry was started without the ee/ module (the AGPL core alone)"}. ` +
  "Nothing else on this registry is affected.";

export const enterpriseAvailability = (
  enterprise: RegistryEnterprise | undefined,
  feature: EnterpriseFeatureId,
): EnterpriseAvailability => {
  if (enterprise === undefined) return { ok: false, reason: enterpriseUnavailable(feature) };
  try {
    const verdict = enterprise.available(feature);
    return verdict.ok ? verdict : { ok: false, reason: enterpriseUnavailable(feature, verdict.reason) };
  } catch {
    return { ok: false, reason: enterpriseUnavailable(feature, "the ee/ module could not check its licence") };
  }
};
