CREATE TABLE workspaces (
  id                TEXT        PRIMARY KEY CHECK (id ~ '^wsp_[0-9a-f]{20}$'),
  org_id            TEXT        NOT NULL,
  user_id           TEXT        NOT NULL,
  host_id           TEXT        REFERENCES sandbox_hosts (id) ON DELETE SET NULL,
  status            TEXT        NOT NULL CHECK (status IN ('stopped', 'starting', 'running', 'stopping', 'failed')),
  profile           JSONB       NOT NULL,
  detach_grace_min  INTEGER     NOT NULL CHECK (detach_grace_min BETWEEN 15 AND 240),
  image_digest      TEXT        CHECK (image_digest IS NULL OR image_digest ~ '^sha256:[0-9a-z]{1,64}$'),
  last_started_at   TIMESTAMPTZ,
  last_stopped_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX workspaces_host_idx ON workspaces (host_id);
CREATE INDEX workspaces_org_status_idx ON workspaces (org_id, status);

CREATE TABLE workspace_sessions (
  id            TEXT        PRIMARY KEY CHECK (id ~ '^wss_[0-9a-f]{20}$'),
  workspace_id  TEXT        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  org_id        TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  agent         TEXT        NOT NULL CHECK (agent IN ('claude', 'codex', 'cmd')),
  name          TEXT        NOT NULL CHECK (name ~ '^[a-z0-9-]{1,32}$'),
  argv_sha256   TEXT        NOT NULL CHECK (argv_sha256 ~ '^[0-9a-f]{64}$'),
  opened_at     TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ,
  close_reason  TEXT        CHECK (close_reason IS NULL OR close_reason IN ('exited', 'killed', 'workspace_stopped'))
);
CREATE INDEX workspace_sessions_open_idx ON workspace_sessions (workspace_id, name) WHERE closed_at IS NULL;

CREATE TABLE workspace_attachments (
  id              TEXT        PRIMARY KEY CHECK (id ~ '^wsa_[0-9a-f]{20}$'),
  session_id      TEXT        NOT NULL REFERENCES workspace_sessions (id) ON DELETE CASCADE,
  org_id          TEXT        NOT NULL,
  opened_at       TIMESTAMPTZ NOT NULL,
  closed_at       TIMESTAMPTZ,
  attach_ms       INTEGER     CHECK (attach_ms IS NULL OR attach_ms >= 0),
  rtt_p50_ms      INTEGER     CHECK (rtt_p50_ms IS NULL OR rtt_p50_ms >= 0),
  echo_p50_ms     INTEGER     CHECK (echo_p50_ms IS NULL OR echo_p50_ms >= 0),
  client_os       TEXT        CHECK (client_os IS NULL OR client_os IN ('darwin', 'linux', 'win32', 'other')),
  client_version  TEXT        CHECK (client_version IS NULL OR client_version ~ '^[0-9A-Za-z.+-]{1,32}$')
);
CREATE INDEX workspace_attachments_session_idx ON workspace_attachments (session_id);

CREATE TABLE workspace_vm_intervals (
  workspace_id  TEXT        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  org_id        TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  stopped_at    TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, started_at)
);
CREATE UNIQUE INDEX workspace_vm_intervals_one_open ON workspace_vm_intervals (workspace_id) WHERE stopped_at IS NULL;

CREATE TABLE workspace_policies (
  org_id            TEXT    PRIMARY KEY,
  claude            TEXT    NOT NULL CHECK (claude IN ('personal', 'org-key', 'off')),
  codex             TEXT    NOT NULL CHECK (codex IN ('chatgpt', 'org-key', 'off')),
  connector_proxy   TEXT    NOT NULL CHECK (connector_proxy IN ('blocked', 'allowed')),
  detach_grace_min  INTEGER NOT NULL CHECK (detach_grace_min BETWEEN 15 AND 240)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orgs WHERE handle = 'host-channel') THEN
    RAISE EXCEPTION 'an organisation holds the handle host-channel, now reserved for the sandbox hosts'' channel; rename its handle, then migrate again';
  END IF;
END
$$;
