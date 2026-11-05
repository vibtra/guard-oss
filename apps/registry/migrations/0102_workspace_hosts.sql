CREATE TABLE workspace_hosts (
  workspace_id   TEXT        NOT NULL CHECK (workspace_id ~ '^wsp_[0-9a-f]{20}$'),
  org_id         TEXT        NOT NULL,
  user_id        TEXT        NOT NULL,
  host_id        TEXT        NOT NULL,
  assigned_at    TIMESTAMPTZ NOT NULL,
  released_at    TIMESTAMPTZ,
  reason         TEXT        CHECK (reason IS NULL OR reason IN ('moved', 'drain', 'failover', 'gone')),
  home_wiped_at  TIMESTAMPTZ
);
CREATE INDEX workspace_hosts_ws_idx ON workspace_hosts (workspace_id, assigned_at);
CREATE INDEX workspace_hosts_host_idx ON workspace_hosts (host_id) WHERE released_at IS NOT NULL AND home_wiped_at IS NULL;
CREATE UNIQUE INDEX workspace_hosts_one_open ON workspace_hosts (workspace_id) WHERE released_at IS NULL;
