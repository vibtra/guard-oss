CREATE TABLE org_agent_identities (
  org_id                 TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id                TEXT        NOT NULL,
  oauth_client_id        TEXT        NOT NULL UNIQUE,
  client_secret_sealed   TEXT        NOT NULL,
  webhook_secret_sealed  TEXT        NOT NULL,
  cron_secret_sealed     TEXT        NOT NULL,
  key_id                 TEXT        NOT NULL,
  triggers               JSONB,
  limits                 JSONB,
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  rotated_at             TIMESTAMPTZ,
  PRIMARY KEY (org_id, tool_id)
);
