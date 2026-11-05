CREATE TABLE host_ca (
  id          TEXT        PRIMARY KEY,
  sealed_key  TEXT        NOT NULL,
  cert_pem    TEXT        NOT NULL,
  not_after   TIMESTAMPTZ NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('current', 'next', 'previous', 'retired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX host_ca_one_current ON host_ca (status) WHERE status = 'current';
CREATE UNIQUE INDEX host_ca_one_next ON host_ca (status) WHERE status = 'next';
CREATE UNIQUE INDEX host_ca_one_previous ON host_ca (status) WHERE status = 'previous';

CREATE TABLE registry_host_identity (
  id          TEXT        PRIMARY KEY,
  ca_id       TEXT        NOT NULL REFERENCES host_ca (id),
  sealed_key  TEXT        NOT NULL,
  cert_pem    TEXT        NOT NULL,
  not_after   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_host_enrolments (
  token_sha256    TEXT        PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  name            TEXT        NOT NULL,
  pool            TEXT        NOT NULL CHECK (pool IN ('shared', 'dedicated')),
  url             TEXT        NOT NULL,
  org_ids         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  used_by_host    TEXT,
  created_by      TEXT        NOT NULL,
  created_by_org  TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_hosts (
  id               TEXT        PRIMARY KEY CHECK (id ~ '^host_[0-9a-f]{16}$'),
  name             TEXT        NOT NULL,
  url              TEXT        NOT NULL,
  pool             TEXT        NOT NULL CHECK (pool IN ('shared', 'dedicated')),
  status           TEXT        NOT NULL CHECK (status IN ('pending', 'active', 'draining', 'revoked')),
  spki_sha256      TEXT        NOT NULL CHECK (spki_sha256 ~ '^[0-9a-f]{64}$'),
  prev_spki_sha256 TEXT        CHECK (prev_spki_sha256 IS NULL OR prev_spki_sha256 ~ '^[0-9a-f]{64}$'),
  prev_spki_until  TIMESTAMPTZ,
  cert_serial      TEXT        NOT NULL,
  cert_not_after   TIMESTAMPTZ NOT NULL,
  enrolled_at      TIMESTAMPTZ NOT NULL,
  last_seen_at     TIMESTAMPTZ,
  created_by       TEXT        NOT NULL,
  created_by_org   TEXT        NOT NULL
);

CREATE TABLE sandbox_host_org_pins (
  host_id  TEXT NOT NULL REFERENCES sandbox_hosts (id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL,
  PRIMARY KEY (host_id, org_id)
);

CREATE TABLE org_host_tier (
  org_id  TEXT PRIMARY KEY,
  tier    TEXT NOT NULL CHECK (tier IN ('shared', 'dedicated'))
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orgs WHERE handle = 'host-enrol') THEN
    RAISE EXCEPTION 'an organisation holds the handle host-enrol, now reserved for the sandbox hosts'' doors; rename its handle, then migrate again';
  END IF;
END
$$;
