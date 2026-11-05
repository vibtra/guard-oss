CREATE TABLE workspace_chats (
  id                TEXT        PRIMARY KEY CHECK (id ~ '^wch_[0-9a-z]{8,40}$'),
  org_id            TEXT        NOT NULL,
  user_id           TEXT        NOT NULL,
  workspace_id      TEXT        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent             TEXT        NOT NULL CHECK (agent IN ('claude', 'codex')),
  auth_mode         TEXT        NOT NULL CHECK (auth_mode IN ('personal', 'org-key', 'chatgpt')),
  mode              TEXT        NOT NULL CHECK (mode IN ('agent', 'plan')),
  model             TEXT        CHECK (model IS NULL OR model ~ '^[a-z0-9][a-z0-9.\-\[\]]{0,63}$'),
  title             TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  status            TEXT        NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'idle', 'ended', 'archived')),
  agent_session_id  TEXT        NOT NULL CHECK (agent_session_id ~ '^[0-9A-Za-z-]{8,64}$'),
  created_at        TIMESTAMPTZ NOT NULL,
  last_turn_at      TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  turns             INTEGER     NOT NULL DEFAULT 0 CHECK (turns >= 0),
  last_seq          INTEGER     NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  repo              TEXT        CHECK (repo IS NULL OR repo ~ '^[a-z0-9._-]{1,64}$'),
  archived_at       TIMESTAMPTZ
);
CREATE INDEX workspace_chats_person_idx ON workspace_chats (org_id, user_id, status);
CREATE INDEX workspace_chats_workspace_idx ON workspace_chats (workspace_id, status);
