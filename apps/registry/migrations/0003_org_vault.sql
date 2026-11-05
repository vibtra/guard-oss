ALTER TABLE orgs ADD COLUMN connection_limit INTEGER;

ALTER TABLE org_tokens ADD COLUMN holder TEXT;

CREATE TABLE org_connections (
  connection_id     TEXT        PRIMARY KEY,
  org_id            TEXT        NOT NULL REFERENCES orgs (org_id),
  provider          TEXT        NOT NULL,
  slug              TEXT        NOT NULL,
  display_name      TEXT        NOT NULL,
  granted_scopes    JSONB       NOT NULL,
  scope_kind        TEXT        NOT NULL,
  scope_subjects    JSONB       NOT NULL,
  sealed_credential TEXT        NOT NULL,
  key_id            TEXT        NOT NULL,
  created_by        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_by        TEXT        NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (org_id, provider, slug)
);
CREATE INDEX org_connections_org ON org_connections (org_id);

CREATE TABLE vault_audit (
  seq           BIGSERIAL   PRIMARY KEY,
  audit_id      TEXT        NOT NULL UNIQUE,
  org_id        TEXT        NOT NULL,
  at            TIMESTAMPTZ NOT NULL,
  event         TEXT        NOT NULL,
  actor_kind    TEXT        NOT NULL CHECK (actor_kind IN ('admin', 'door')),
  actor         TEXT        NOT NULL,
  token_id      TEXT,
  token_name    TEXT,
  connection_id TEXT,
  provider      TEXT,
  tool_id       TEXT,
  granted       INTEGER,
  withheld      INTEGER,
  outcome       TEXT        NOT NULL CHECK (outcome IN ('allowed', 'refused')),
  detail        TEXT
);
CREATE INDEX vault_audit_org_seq ON vault_audit (org_id, seq);

CREATE TRIGGER vault_audit_append_only
  BEFORE UPDATE OR DELETE ON vault_audit
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();
