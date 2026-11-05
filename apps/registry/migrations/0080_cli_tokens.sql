CREATE TABLE cli_tokens (
  id             TEXT        PRIMARY KEY CHECK (id ~ '^cli_[0-9a-f]{20}$'),
  token_sha256   TEXT        NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  org_id         TEXT        NOT NULL,
  user_id        TEXT        NOT NULL,
  client_meta    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX cli_tokens_user_idx ON cli_tokens (org_id, user_id);

CREATE TABLE cli_device_requests (
  device_code_sha256  TEXT        PRIMARY KEY CHECK (device_code_sha256 ~ '^[0-9a-f]{64}$'),
  user_code           TEXT        NOT NULL UNIQUE,
  org_id              TEXT,
  client_meta         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orgs WHERE handle = 'device') THEN
    RAISE EXCEPTION 'an organisation holds the handle device, now reserved for the CLI sign-in page; rename its handle, then migrate again';
  END IF;
END
$$;
