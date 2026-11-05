CREATE TABLE app_box_backups (
  id          TEXT        PRIMARY KEY CHECK (id ~ '^abk_[0-9a-f]{20}$'),
  box_id      TEXT        NOT NULL CHECK (box_id ~ '^abx_[0-9a-z]{8,40}$'),
  org_id      TEXT        NOT NULL,
  object_key  TEXT        NOT NULL CHECK (char_length(object_key) <= 300),
  bytes       BIGINT      NOT NULL CHECK (bytes >= 0),
  kind        TEXT        NOT NULL CHECK (kind IN ('sleep', 'online', 'park', 'final')),
  host_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX app_box_backups_box_idx ON app_box_backups (box_id, created_at DESC);
