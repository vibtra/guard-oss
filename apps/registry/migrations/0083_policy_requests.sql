CREATE TABLE policy_requests (
  id                 TEXT        PRIMARY KEY CHECK (id ~ '^preq_[0-9a-f]{20}$'),
  org_id             TEXT        NOT NULL,
  workspace_id       TEXT        CHECK (workspace_id IS NULL OR workspace_id ~ '^wsp_[0-9a-f]{20}$'),
  session_id         TEXT        CHECK (session_id IS NULL OR session_id ~ '^wss_[0-9a-f]{20}$'),
  requester_user_id  TEXT        NOT NULL,
  kind               TEXT        NOT NULL CHECK (kind IN ('package', 'egress-host', 'connector', 'model', 'policy-change', 'package-registry', 'image-change')),
  subject            JSONB       NOT NULL,
  subject_key        TEXT        NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 300),
  why                TEXT        CHECK (why IS NULL OR char_length(why) <= 280),
  proposed_revision  TEXT        CHECK (proposed_revision IS NULL OR proposed_revision ~ '^rev_[a-z2-7]{26}$'),
  base_revision      TEXT        CHECK (base_revision IS NULL OR base_revision ~ '^rev_[a-z2-7]{26}$'),
  status             TEXT        NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'cancelled', 'superseded')),
  decided_by         TEXT,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT        CHECK (decision_note IS NULL OR char_length(decision_note) <= 280),
  grant_id           TEXT        CHECK (grant_id IS NULL OR grant_id ~ '^pgr_[0-9a-f]{20}$'),
  reminder_at        TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX policy_requests_one_open ON policy_requests (org_id, coalesce(workspace_id, ''), kind, subject_key) WHERE status = 'pending';
CREATE INDEX policy_requests_org_status_idx ON policy_requests (org_id, status, created_at DESC);
