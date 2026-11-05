CREATE TABLE engine_session_tokens (
  token_id    TEXT        PRIMARY KEY,
  token_hash  TEXT        NOT NULL UNIQUE,
  org_id      TEXT        NOT NULL REFERENCES orgs (org_id),
  person      TEXT        NOT NULL,
  project_id  TEXT        NOT NULL,
  session_id  TEXT        NOT NULL,
  scopes      TEXT[]      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX engine_session_tokens_by_session ON engine_session_tokens (org_id, session_id);
