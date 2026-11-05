ALTER TABLE org_deploy_targets ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX org_deploy_targets_one_default
  ON org_deploy_targets (org_id)
  WHERE is_default;
