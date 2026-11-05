CREATE TABLE policy_grants (
  id           TEXT        PRIMARY KEY CHECK (id ~ '^pgr_[0-9a-f]{20}$'),
  org_id       TEXT        NOT NULL,
  scope        TEXT        NOT NULL CHECK (scope IN ('org', 'user')),
  user_id      TEXT,
  kind         TEXT        NOT NULL CHECK (kind IN ('package', 'egress-host', 'connector', 'model', 'package-registry')),
  subject      JSONB       NOT NULL,
  subject_key  TEXT        NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 300),
  expires_at   TIMESTAMPTZ,
  request_id   TEXT        NOT NULL CHECK (request_id ~ '^preq_[0-9a-f]{20}$'),
  approved_by  TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  revoked_by   TEXT,
  CHECK ((scope = 'user') = (user_id IS NOT NULL))
);
CREATE INDEX policy_grants_org_idx ON policy_grants (org_id, revoked_at, expires_at);
