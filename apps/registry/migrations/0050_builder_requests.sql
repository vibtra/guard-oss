CREATE TABLE builder_requests (
  request_id          TEXT        PRIMARY KEY,
  org_id              TEXT        NOT NULL REFERENCES orgs (org_id),
  kind                TEXT        NOT NULL,
  subject             TEXT        NOT NULL,
  reason              TEXT        NOT NULL,
  session_id          TEXT        NOT NULL,
  project_id          TEXT        NOT NULL,
  commit_sha          TEXT,
  person              TEXT        NOT NULL,
  engine_request_id   TEXT,
  package_request_id  TEXT,
  status              TEXT        NOT NULL,
  decided_by          TEXT,
  decision_note       TEXT,
  decided_at          TIMESTAMPTZ,
  approved_version    TEXT,
  reminded_at         TIMESTAMPTZ,
  resume_acked_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX builder_requests_by_org ON builder_requests (org_id, created_at DESC);

CREATE INDEX builder_requests_resume ON builder_requests (org_id, session_id)
  WHERE status <> 'pending' AND resume_acked_at IS NULL;

CREATE INDEX builder_requests_pending ON builder_requests (created_at) WHERE status = 'pending';

CREATE UNIQUE INDEX builder_requests_one_open
  ON builder_requests (org_id, session_id, kind, subject)
  WHERE status = 'pending';
