CREATE TABLE policy_revisions (
  org_id            TEXT        NOT NULL,
  revision          TEXT        NOT NULL CHECK (revision ~ '^rev_[a-z2-7]{26}$'),
  parent_revision   TEXT        CHECK (parent_revision IS NULL OR parent_revision ~ '^rev_[a-z2-7]{26}$'),
  doc               JSONB       NOT NULL,
  doc_bytes         INTEGER     NOT NULL CHECK (doc_bytes BETWEEN 2 AND 262144),
  author_user_id    TEXT        NOT NULL,
  approver_user_id  TEXT,
  request_id        TEXT        CHECK (request_id IS NULL OR request_id ~ '^preq_[0-9a-f]{20}$'),
  source            TEXT        NOT NULL CHECK (source IN ('console', 'api', 'sdk', 'migration')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, revision)
);
CREATE INDEX policy_revisions_org_created_idx ON policy_revisions (org_id, created_at DESC);

CREATE TABLE policy_heads (
  org_id      TEXT        PRIMARY KEY,
  revision    TEXT        NOT NULL CHECK (revision ~ '^rev_[a-z2-7]{26}$'),
  version     INTEGER     NOT NULL CHECK (version >= 1),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
