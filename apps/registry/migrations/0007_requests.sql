CREATE TABLE access_requests (
  request_id      TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id         TEXT        NOT NULL,
  requester_email TEXT        NOT NULL,
  status          TEXT        NOT NULL,
  note            TEXT,
  decided_by      TEXT,
  decision_note   TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX access_requests_org ON access_requests (org_id, created_at DESC);

CREATE UNIQUE INDEX access_requests_one_open
  ON access_requests (org_id, tool_id, requester_email)
  WHERE status = 'pending';
