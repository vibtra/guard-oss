import { z } from "zod";

const SQL_TLS_MODES = ["disable", "prefer", "require", "verify-ca", "verify-full"] as const;
export const SqlTlsMode = z.enum(SQL_TLS_MODES);
export type SqlTlsMode = z.infer<typeof SqlTlsMode>;

const CONNECTOR_PROVIDER_IDS = [
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
] as const;
export const ConnectorProviderIdEnum = z.enum(CONNECTOR_PROVIDER_IDS);

const CONNECTION_SLUG_PATTERN = /^(?=.{2,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const ConnectorConnectionSlug = z.string().regex(CONNECTION_SLUG_PATTERN);

const CONNECTOR_PROBE_STATUSES = [
  "ok",
  "expired",
  "revoked",
  "insufficient_scope",
  "unreachable",
] as const;
export const ConnectorProbeStatus = z.enum(CONNECTOR_PROBE_STATUSES);
export type ConnectorProbeStatus = z.infer<typeof ConnectorProbeStatus>;
