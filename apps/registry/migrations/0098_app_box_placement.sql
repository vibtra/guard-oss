CREATE TABLE app_box_hosts (
  box_id       TEXT        NOT NULL CHECK (box_id ~ '^abx_[0-9a-z]{8,40}$'),
  org_id       TEXT        NOT NULL,
  host_id      TEXT        NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL,
  released_at  TIMESTAMPTZ,
  reason       TEXT        CHECK (reason IS NULL OR reason IN ('gone', 'park', 'delete', 'moved'))
);
CREATE INDEX app_box_hosts_box_idx ON app_box_hosts (box_id, assigned_at);
CREATE UNIQUE INDEX app_box_hosts_one_open ON app_box_hosts (box_id) WHERE released_at IS NULL;

ALTER TABLE app_boxes ADD COLUMN ingress_secret_sealed TEXT CHECK (ingress_secret_sealed IS NULL OR ingress_secret_sealed LIKE 'vault.%' OR ingress_secret_sealed LIKE 'bao.%');
ALTER TABLE app_boxes ADD COLUMN last_wake_ms INT CHECK (last_wake_ms IS NULL OR last_wake_ms >= 0);
ALTER TABLE app_boxes ADD COLUMN last_backup_at TIMESTAMPTZ;
ALTER TABLE app_boxes ADD COLUMN storage_warned_at TIMESTAMPTZ;
