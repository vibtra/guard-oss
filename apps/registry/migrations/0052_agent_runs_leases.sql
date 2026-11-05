CREATE TABLE org_agent_runs (
  run_id        TEXT        PRIMARY KEY,
  org_id        TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id       TEXT        NOT NULL,
  trigger_kind  TEXT        NOT NULL,
  trigger_name  TEXT,
  status        TEXT        NOT NULL,
  day           DATE        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  duration_ms   BIGINT,
  error         TEXT,
  refusal       TEXT,
  action_count  INTEGER     NOT NULL DEFAULT 0,
  spend_usd     NUMERIC(14, 6) NOT NULL DEFAULT 0,
  head_hash     TEXT        NOT NULL
);
CREATE INDEX org_agent_runs_org_started ON org_agent_runs (org_id, started_at DESC);
CREATE INDEX org_agent_runs_tool_day ON org_agent_runs (org_id, tool_id, day);
CREATE INDEX org_agent_runs_trigger ON org_agent_runs (org_id, tool_id, trigger_name, started_at DESC);

CREATE TABLE org_agent_actions (
  action_id     TEXT        PRIMARY KEY,
  org_id        TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id       TEXT        NOT NULL,
  run_id        TEXT        NOT NULL REFERENCES org_agent_runs (run_id),
  seq           INTEGER     NOT NULL,
  name          TEXT        NOT NULL,
  connection_id TEXT,
  cost_usd      NUMERIC(14, 6) NOT NULL,
  outcome       TEXT        NOT NULL,
  detail        TEXT,
  at            TIMESTAMPTZ NOT NULL,
  prev_hash     TEXT        NOT NULL,
  hash          TEXT        NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TRIGGER org_agent_actions_append_only
  BEFORE UPDATE OR DELETE ON org_agent_actions
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();

CREATE TABLE org_agent_leases (
  lease_id        TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id         TEXT        NOT NULL,
  run_id          TEXT,
  kind            TEXT        NOT NULL,
  connection_id   TEXT        NOT NULL,
  vault_lease_id  TEXT,
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);
CREATE INDEX org_agent_leases_live ON org_agent_leases (org_id, tool_id) WHERE revoked_at IS NULL;

CREATE TABLE org_agent_breaker (
  org_id      TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id     TEXT        NOT NULL,
  state       TEXT        NOT NULL,
  reason      TEXT,
  detail      TEXT,
  tripped_at  TIMESTAMPTZ,
  reset_at    TIMESTAMPTZ,
  reset_by    TEXT,
  PRIMARY KEY (org_id, tool_id)
);
