CREATE TABLE builder_journal_snapshots (
  org_id        TEXT        NOT NULL REFERENCES orgs (org_id),
  session_id    TEXT        NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  sealed        BYTEA       NOT NULL,
  sealed_key    TEXT        NOT NULL,
  key_id        TEXT        NOT NULL,
  bytes         BIGINT      NOT NULL CHECK (bytes >= 0),
  stored_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until  TIMESTAMPTZ,
  PRIMARY KEY (org_id, session_id)
);

CREATE INDEX builder_journal_snapshots_retain ON builder_journal_snapshots (retain_until) WHERE retain_until IS NOT NULL;
