CREATE TABLE slack_installations (
  org_id               TEXT        NOT NULL REFERENCES orgs (org_id),
  team_id              TEXT        NOT NULL UNIQUE,
  team_name            TEXT        NOT NULL,
  bot_user_id          TEXT        NOT NULL,
  bot_token_sealed     TEXT        NOT NULL,
  key_id               TEXT        NOT NULL,
  scopes               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  installed_by         TEXT        NOT NULL,
  approval_channel_id  TEXT,
  installed_at         TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, team_id)
);

CREATE UNIQUE INDEX slack_installations_one_per_org ON slack_installations (org_id);

CREATE TABLE slack_install_states (
  state_hash   TEXT        PRIMARY KEY,
  org_id       TEXT        NOT NULL REFERENCES orgs (org_id),
  admin_email  TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX slack_install_states_expiry ON slack_install_states (expires_at);

CREATE TABLE slack_user_links (
  team_id        TEXT        NOT NULL,
  slack_user_id  TEXT        NOT NULL,
  org_id         TEXT        NOT NULL REFERENCES orgs (org_id),
  email          TEXT        NOT NULL,
  linked_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);

CREATE INDEX slack_user_links_by_org ON slack_user_links (org_id);

CREATE TABLE slack_event_ids (
  team_id      TEXT        NOT NULL,
  event_id     TEXT        NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (team_id, event_id)
);

CREATE INDEX slack_event_ids_age ON slack_event_ids (received_at);
