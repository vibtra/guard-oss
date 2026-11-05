CREATE TABLE org_integrations (
  org_id       TEXT        NOT NULL REFERENCES orgs (org_id),
  provider     TEXT        NOT NULL,
  sealed_token TEXT        NOT NULL,
  key_id       TEXT        NOT NULL,
  connected_by TEXT        NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL,
  vaults       JSONB       NOT NULL,
  last_used_at TIMESTAMPTZ,
  last_refusal TEXT,
  PRIMARY KEY (org_id, provider)
);
CREATE INDEX org_integrations_org ON org_integrations (org_id);

ALTER TABLE org_deploy_targets ADD COLUMN credential_ref TEXT;
ALTER TABLE org_connections    ADD COLUMN credential_ref TEXT;
ALTER TABLE org_tokens         ADD COLUMN onepassword_item_id TEXT;
