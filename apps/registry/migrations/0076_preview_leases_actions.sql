CREATE TABLE org_preview_leases (
  lease_id        TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL REFERENCES orgs (org_id),
  project_id      TEXT        NOT NULL,
  session_id      TEXT        NOT NULL,
  person          TEXT        NOT NULL,
  connection_id   TEXT        NOT NULL,
  kind            TEXT        NOT NULL,
  preview_mode    TEXT        NOT NULL,
  openbao_lease_id TEXT,
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);
CREATE INDEX org_preview_leases_live ON org_preview_leases (org_id, session_id) WHERE revoked_at IS NULL;

CREATE TABLE org_preview_actions (
  action_id      TEXT        PRIMARY KEY,
  org_id         TEXT        NOT NULL REFERENCES orgs (org_id),
  project_id     TEXT        NOT NULL,
  session_id     TEXT        NOT NULL,
  person         TEXT        NOT NULL,
  connection_id  TEXT        NOT NULL,
  method         TEXT        NOT NULL,
  path_template  TEXT        NOT NULL,
  status         INTEGER     NOT NULL,
  bytes          BIGINT      NOT NULL,
  row_count      INTEGER,
  refused        BOOLEAN     NOT NULL DEFAULT FALSE,
  detail         TEXT,
  at             TIMESTAMPTZ NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX org_preview_actions_session ON org_preview_actions (org_id, session_id, at);

CREATE TRIGGER org_preview_actions_append_only
  BEFORE UPDATE OR DELETE ON org_preview_actions
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();
