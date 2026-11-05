CREATE TABLE policy_decisions (
  id            TEXT        PRIMARY KEY CHECK (id ~ '^pd_[A-Za-z0-9]{8,64}$'),
  org_id        TEXT        NOT NULL,
  workspace_id  TEXT        NOT NULL CHECK (workspace_id ~ '^wsp_[0-9a-f]{20}$'),
  session_id    TEXT        CHECK (session_id IS NULL OR session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$'),
  at            TIMESTAMPTZ NOT NULL,
  decision      TEXT        NOT NULL CHECK (decision IN ('allow', 'deny', 'pending', 'approved', 'declined', 'expired')),
  family        TEXT        NOT NULL CHECK (family IN ('package', 'connection', 'file', 'deploy', 'model', 'preview', 'session')),
  codes         TEXT[]      NOT NULL,
  subject_key   TEXT        NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 300),
  revision      TEXT,
  request_id    TEXT        CHECK (request_id IS NULL OR request_id ~ '^preq_[0-9a-f]{20}$')
);
CREATE INDEX policy_decisions_org_at_idx ON policy_decisions (org_id, at);
CREATE INDEX policy_decisions_subject_idx ON policy_decisions (org_id, subject_key, at);
