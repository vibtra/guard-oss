DROP TABLE guard_signing_keys;

CREATE TABLE guard_org_signing_keys (
  key_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  public_key_pem TEXT NOT NULL,
  sealed_private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX guard_org_signing_keys_one_active ON guard_org_signing_keys (org_id) WHERE status = 'active';
