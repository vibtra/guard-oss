CREATE TABLE app_box_secrets (
  box_id         TEXT        NOT NULL CHECK (box_id ~ '^abx_[0-9a-z]{8,40}$'),
  org_id         TEXT        NOT NULL,
  env_name       TEXT        NOT NULL CHECK (env_name ~ '^[A-Z_][A-Z0-9_]{0,63}$'),
  source_kind    TEXT        NOT NULL CHECK (source_kind IN ('connection', 'value')),
  connection_id  TEXT        CHECK (connection_id IS NULL OR connection_id ~ '^conn_[A-Za-z0-9_-]{1,64}$'),
  sealed_value   TEXT,
  set_by         TEXT        NOT NULL,
  set_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (box_id, env_name),
  CHECK ((source_kind = 'connection') = (connection_id IS NOT NULL)),
  CHECK (source_kind = 'value' OR sealed_value IS NULL)
);
CREATE INDEX app_box_secrets_org_idx ON app_box_secrets (org_id);

ALTER TABLE vault_audit DROP CONSTRAINT IF EXISTS vault_audit_actor_kind_check;
ALTER TABLE vault_audit
  ADD CONSTRAINT vault_audit_actor_kind_check CHECK (actor_kind IN ('admin', 'door', 'member', 'app'));
