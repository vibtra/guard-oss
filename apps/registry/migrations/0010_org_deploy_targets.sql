CREATE TABLE org_deploy_targets (
  target_id         TEXT        PRIMARY KEY,
  org_id            TEXT        NOT NULL REFERENCES orgs (org_id),
  provider          TEXT        NOT NULL,
  label             TEXT        NOT NULL,
  account           TEXT,
  sealed_credential TEXT        NOT NULL,
  key_id            TEXT        NOT NULL,
  created_by        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  last_used_at      TIMESTAMPTZ,
  UNIQUE (org_id, provider)
);
CREATE INDEX org_deploy_targets_org ON org_deploy_targets (org_id);
