CREATE TABLE code_fallback_versions (
  org_id      TEXT        NOT NULL REFERENCES orgs (org_id),
  project_id  TEXT        NOT NULL,
  sha         TEXT        NOT NULL CHECK (sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  blob_key    TEXT        NOT NULL UNIQUE,
  sealed_key  TEXT        NOT NULL,
  key_id      TEXT        NOT NULL,
  bytes       BIGINT      NOT NULL CHECK (bytes >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, sha)
);

CREATE INDEX code_fallback_versions_latest ON code_fallback_versions (org_id, project_id, created_at DESC);
