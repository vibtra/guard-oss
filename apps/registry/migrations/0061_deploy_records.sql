CREATE TABLE deploy_records (
  deploy_id      TEXT        PRIMARY KEY,
  org_id         TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  state          TEXT        NOT NULL,
  meta           JSONB       NOT NULL,
  url            TEXT,
  receipt_id     TEXT,
  failure_reason TEXT,
  checks         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  log_tail       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  log_seq        INTEGER     NOT NULL DEFAULT 0,
  trace_id       TEXT        NOT NULL,
  runner_id      TEXT        NOT NULL,
  heartbeat_at   TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  CONSTRAINT deploy_records_org_slug UNIQUE (org_id, slug)
);
CREATE INDEX deploy_records_org_created ON deploy_records (org_id, created_at DESC);
CREATE INDEX deploy_records_in_flight ON deploy_records (heartbeat_at)
  WHERE state IN ('QUEUED', 'BUILDING', 'CHECKING', 'STARTING');

CREATE TABLE deploy_log_lines (
  deploy_id  TEXT        NOT NULL REFERENCES deploy_records (deploy_id) ON DELETE CASCADE,
  seq        INTEGER     NOT NULL,
  at         TIMESTAMPTZ NOT NULL,
  line       TEXT        NOT NULL,
  PRIMARY KEY (deploy_id, seq)
);
CREATE INDEX deploy_log_lines_at ON deploy_log_lines (at);
