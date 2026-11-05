CREATE TABLE org_git_connections (
  org_id           TEXT        PRIMARY KEY REFERENCES orgs (org_id),
  provider         TEXT        NOT NULL,
  installation_id  TEXT,
  sealed_token     TEXT,
  key_id           TEXT,
  account_login    TEXT        NOT NULL,
  group_id         TEXT,
  base_url         TEXT        NOT NULL,
  token_expires_at TIMESTAMPTZ,
  connected_by     TEXT        NOT NULL,
  connected_at     TIMESTAMPTZ NOT NULL,
  last_used_at     TIMESTAMPTZ,
  last_refusal     TEXT,
  CONSTRAINT org_git_connections_shape CHECK (
    (provider = 'github' AND installation_id IS NOT NULL AND sealed_token IS NULL AND key_id IS NULL AND group_id IS NULL)
    OR
    (provider = 'gitlab' AND installation_id IS NULL AND sealed_token IS NOT NULL AND key_id IS NOT NULL AND group_id IS NOT NULL)
  ),
  CONSTRAINT org_git_connections_https CHECK (base_url LIKE 'https://%')
);
CREATE UNIQUE INDEX org_git_connections_installation
  ON org_git_connections (installation_id) WHERE installation_id IS NOT NULL;
