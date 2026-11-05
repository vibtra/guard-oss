CREATE TABLE org_agent_controls (
  org_id      TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id     TEXT        NOT NULL,
  state       TEXT        NOT NULL,
  reason      TEXT,
  detail      TEXT,
  changed_at  TIMESTAMPTZ NOT NULL,
  changed_by  TEXT        NOT NULL,
  PRIMARY KEY (org_id, tool_id)
);

CREATE TABLE org_agent_trigger_state (
  org_id        TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id       TEXT        NOT NULL,
  trigger_name  TEXT        NOT NULL,
  enabled       BOOLEAN     NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL,
  changed_by    TEXT        NOT NULL,
  PRIMARY KEY (org_id, tool_id, trigger_name)
);

CREATE TABLE org_agent_missed_run_alerts (
  org_id        TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id       TEXT        NOT NULL,
  trigger_name  TEXT        NOT NULL,
  expected_at   TIMESTAMPTZ NOT NULL,
  kind          TEXT        NOT NULL,
  alerted_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, tool_id, trigger_name, expected_at, kind)
);
