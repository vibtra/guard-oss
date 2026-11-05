CREATE TABLE registry_records (
  seq         BIGSERIAL PRIMARY KEY,
  org_id      TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  tool_id     TEXT,
  type        TEXT        NOT NULL,
  known       BOOLEAN     NOT NULL,
  body        JSONB       NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, record_id)
);
CREATE INDEX registry_records_org_seq  ON registry_records (org_id, seq);
CREATE INDEX registry_records_org_tool ON registry_records (org_id, tool_id);

CREATE TABLE registry_receipts (
  receipt_id  TEXT        PRIMARY KEY,
  org_id      TEXT        NOT NULL,
  source      TEXT        CHECK (source IN ('client')),
  body        JSONB       NOT NULL,
  created_at  TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX registry_receipts_org ON registry_receipts (org_id);

CREATE FUNCTION vibtra_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % on % is forbidden', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER registry_records_append_only
  BEFORE UPDATE OR DELETE ON registry_records
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();
CREATE TRIGGER registry_receipts_append_only
  BEFORE UPDATE OR DELETE ON registry_receipts
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();

CREATE TABLE orgs (
  org_id          TEXT        PRIMARY KEY,
  name            TEXT        NOT NULL,
  domain          TEXT        UNIQUE,
  live_tool_limit INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org_users (
  issuer     TEXT        NOT NULL,
  subject    TEXT        NOT NULL,
  email      TEXT        NOT NULL,
  org_id     TEXT        NOT NULL REFERENCES orgs (org_id),
  role       TEXT        NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX org_users_org ON org_users (org_id);

CREATE TABLE org_tokens (
  token_id   TEXT        PRIMARY KEY,
  org_id     TEXT        NOT NULL REFERENCES orgs (org_id),
  name       TEXT        NOT NULL,
  token_hash TEXT        NOT NULL UNIQUE,
  created_by TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX org_tokens_org ON org_tokens (org_id);
