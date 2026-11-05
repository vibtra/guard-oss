CREATE TABLE plan_change_requests (
  request_id      TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL REFERENCES orgs (org_id),
  requester_email TEXT        NOT NULL,
  current_plan    TEXT        NOT NULL,
  wanted_plan     TEXT        NOT NULL,
  note            TEXT,
  status          TEXT        NOT NULL,
  decided_by      TEXT,
  decision_note   TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX plan_change_requests_open ON plan_change_requests (status, created_at);

CREATE UNIQUE INDEX plan_change_requests_one_open
  ON plan_change_requests (org_id)
  WHERE status = 'pending';
