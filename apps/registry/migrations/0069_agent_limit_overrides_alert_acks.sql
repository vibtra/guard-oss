CREATE TABLE org_agent_limit_overrides (
  org_id   TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id  TEXT        NOT NULL,
  limits   JSONB       NOT NULL,
  reason   TEXT,
  set_at   TIMESTAMPTZ NOT NULL,
  set_by   TEXT        NOT NULL,
  PRIMARY KEY (org_id, tool_id)
);

ALTER TABLE org_agent_missed_run_alerts
  ADD COLUMN acknowledged_at TIMESTAMPTZ,
  ADD COLUMN acknowledged_by TEXT;
