CREATE TABLE org_tools (
  org_id                     TEXT        NOT NULL REFERENCES orgs (org_id),
  tool_id                    TEXT        NOT NULL,
  name                       TEXT        NOT NULL,
  owner_email                TEXT        NOT NULL,
  audience_kind              TEXT        NOT NULL,
  audience_subjects          JSONB       NOT NULL,
  oauth_client_id            TEXT        NOT NULL UNIQUE,
  oauth_client_secret_sealed TEXT        NOT NULL,
  oauth_key_id               TEXT        NOT NULL,
  oauth_redirect_uris        JSONB       NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL,
  updated_at                 TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, tool_id)
);

CREATE INDEX org_tools_org ON org_tools (org_id);
