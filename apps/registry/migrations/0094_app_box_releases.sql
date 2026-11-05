ALTER TABLE app_boxes DROP CONSTRAINT app_boxes_status_check;
ALTER TABLE app_boxes ADD CONSTRAINT app_boxes_status_check
  CHECK (status IN ('provisioning', 'asleep', 'waking', 'awake', 'sleeping', 'parked', 'restoring', 'failed', 'deleting', 'deleted', 'stopped'));
ALTER TABLE app_boxes ADD COLUMN app_name TEXT CHECK (app_name IS NULL OR app_name ~ '^[a-z0-9](-?[a-z0-9])*$');
ALTER TABLE app_boxes ADD COLUMN label TEXT CHECK (label IS NULL OR char_length(label) <= 63);
ALTER TABLE app_boxes ADD COLUMN principal_id TEXT CHECK (principal_id IS NULL OR principal_id ~ '^app_[0-9a-f]{20}$');
ALTER TABLE app_boxes ADD COLUMN owner_user_id TEXT;
ALTER TABLE app_boxes ADD COLUMN active_release_id TEXT;
ALTER TABLE app_boxes ADD COLUMN host_id TEXT;
ALTER TABLE app_boxes ADD COLUMN last_request_at TIMESTAMPTZ;
ALTER TABLE app_boxes ADD COLUMN last_awake_at TIMESTAMPTZ;
ALTER TABLE app_boxes ADD COLUMN storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0);
ALTER TABLE app_boxes ADD COLUMN crash_count INT NOT NULL DEFAULT 0 CHECK (crash_count >= 0);
ALTER TABLE app_boxes ADD COLUMN crash_window_from TIMESTAMPTZ;
ALTER TABLE app_boxes ADD COLUMN parked_at TIMESTAMPTZ;
CREATE UNIQUE INDEX app_boxes_live_label ON app_boxes (label) WHERE label IS NOT NULL AND status <> 'deleted';
CREATE UNIQUE INDEX app_boxes_live_app ON app_boxes (org_id, app_name) WHERE app_name IS NOT NULL AND status <> 'deleted';

CREATE TABLE app_releases (
  id               TEXT        PRIMARY KEY CHECK (id ~ '^arl_[0-9a-f]{20}$'),
  box_id           TEXT        NOT NULL CHECK (box_id ~ '^abx_[0-9a-z]{8,40}$'),
  org_id           TEXT        NOT NULL,
  app_name         TEXT        NOT NULL CHECK (app_name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  seq              INT         NOT NULL CHECK (seq >= 1),
  commit_sha       TEXT        NOT NULL CHECK (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  repo_name        TEXT        NOT NULL CHECK (repo_name ~ '^[A-Za-z0-9._-]{1,100}$'),
  manifest_json    JSONB       NOT NULL,
  manifest_hash    TEXT        NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  image_id         TEXT,
  status           TEXT        NOT NULL CHECK (status IN ('requested', 'approved', 'building', 'built', 'active', 'declined', 'expired', 'superseded', 'cancelled', 'build_failed')),
  request_id       TEXT        CHECK (request_id IS NULL OR request_id ~ '^preq_[0-9a-f]{20}$'),
  bundle_key       TEXT        CHECK (bundle_key IS NULL OR char_length(bundle_key) <= 300),
  bundle_bytes     BIGINT      CHECK (bundle_bytes IS NULL OR bundle_bytes >= 0),
  artifact_key     TEXT        CHECK (artifact_key IS NULL OR char_length(artifact_key) <= 300),
  artifact_digest  TEXT        CHECK (artifact_digest IS NULL OR artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  requested_by     TEXT        NOT NULL,
  decided_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  decided_at       TIMESTAMPTZ,
  built_at         TIMESTAMPTZ,
  activated_at     TIMESTAMPTZ,
  error_code       TEXT        CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,63}$')
);
CREATE UNIQUE INDEX app_releases_box_seq ON app_releases (box_id, seq);
CREATE INDEX app_releases_org_idx ON app_releases (org_id, app_name, created_at DESC);
CREATE INDEX app_releases_request_idx ON app_releases (request_id) WHERE request_id IS NOT NULL;
