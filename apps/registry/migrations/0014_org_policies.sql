CREATE TABLE org_policies (
  org_id     TEXT        PRIMARY KEY REFERENCES orgs (org_id),
  doc        JSONB       NOT NULL,
  version    INTEGER     NOT NULL,
  updated_by TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
