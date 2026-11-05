import { describe, expect, it } from "vitest";
import { ConnectorConnectionSlug, ConnectorProbeStatus, ConnectorProviderIdEnum, SqlTlsMode } from "@vibtra/registry/src/vault/connector.ts";
import { DynamicConfig } from "@vibtra/registry/src/vault/dynamic.ts";
import { OrgConnectionRow, StoredProbe } from "@vibtra/registry/src/vault/store.ts";

const PROVIDERS = [
  "google-workspace",
  "databricks",
  "sql",
  "microsoft-entra",
  "atlassian",
  "generic-rest",
  "google-service-account",
  "oauth2-m2m",
  "aws-sigv4",
  "snowflake-keypair",
  "okta-private-key-jwt",
];
const PROBE_STATUSES = ["ok", "expired", "revoked", "insufficient_scope", "unreachable"];
const TLS_MODES = ["disable", "prefer", "require", "verify-ca", "verify-full"];

const storedRow = {
  connectionId: "conn_0123456789abcdef",
  orgId: "org-example",
  provider: "generic-rest",
  slug: "team-crm",
  displayName: "Team CRM",
  grantedScopes: ["read"],
  scopeKind: "api",
  scopeSubjects: [],
  sealedCredential: "sealed",
  keyId: "key-1",
  createdBy: "ada@example.test",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedBy: "ada@example.test",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("the connector enums stored connection rows are read through", () => {
  it("keep every value already written to the connections table", () => {
    expect(ConnectorProviderIdEnum.options).toEqual(PROVIDERS);
    expect(ConnectorProbeStatus.options).toEqual(PROBE_STATUSES);
    expect(SqlTlsMode.options).toEqual(TLS_MODES);
  });

  it.each(PROVIDERS)("a stored %s row parses", (provider) => {
    expect(OrgConnectionRow.safeParse({ ...storedRow, provider }).success).toBe(true);
  });

  it.each(PROBE_STATUSES)("a stored row whose last probe was %s parses", (status) => {
    const lastProbe = { status, checkedAt: "2026-10-02T00:00:00.000Z", missingScopes: status === "insufficient_scope" ? ["write"] : [] };
    expect(StoredProbe.safeParse(lastProbe).success).toBe(true);
    expect(OrgConnectionRow.safeParse({ ...storedRow, lastProbe }).success).toBe(true);
  });

  it.each(TLS_MODES)("a stored dynamic sql row with tls %s parses", (tls) => {
    const dynamicConfig = { engine: "postgres", access: "ro", schemas: ["public"], maxTtlDays: 7, host: "db.example.test", port: "5432", database: "app", tls, roleNames: ["vibtra_ro"], rootRotatedAt: null };
    expect(DynamicConfig.safeParse(dynamicConfig).success).toBe(true);
    expect(OrgConnectionRow.safeParse({ ...storedRow, provider: "sql", credentialMode: "dynamic", dynamicConfig }).success).toBe(true);
  });

  it("refuses a provider, probe status, tls mode or slug it does not know", () => {
    expect(OrgConnectionRow.safeParse({ ...storedRow, provider: "salesforce" }).success).toBe(false);
    expect(ConnectorProbeStatus.safeParse("forbidden").success).toBe(false);
    expect(SqlTlsMode.safeParse("allow").success).toBe(false);
    expect(ConnectorConnectionSlug.safeParse("Team CRM").success).toBe(false);
    expect(ConnectorConnectionSlug.safeParse("team-crm").success).toBe(true);
  });
});
