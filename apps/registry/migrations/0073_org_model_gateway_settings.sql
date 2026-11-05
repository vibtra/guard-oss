CREATE TABLE org_model_gateway_settings (
  org_id      TEXT        PRIMARY KEY REFERENCES orgs (org_id),
  posture     JSONB,
  caps        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  updated_by  TEXT        NOT NULL
);
