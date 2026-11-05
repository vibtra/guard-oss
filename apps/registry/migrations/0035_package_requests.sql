CREATE TABLE package_requests (
  request_id      TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL REFERENCES orgs (org_id),
  requester_email TEXT        NOT NULL,
  package_name    TEXT        NOT NULL,
  range           TEXT        NOT NULL,
  tool_id         TEXT,
  note            TEXT,
  status          TEXT        NOT NULL,
  decided_by      TEXT,
  decision_note   TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX package_requests_by_org ON package_requests (org_id, created_at DESC);

CREATE UNIQUE INDEX package_requests_one_open
  ON package_requests (org_id, package_name)
  WHERE status = 'pending';
