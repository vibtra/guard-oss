CREATE TABLE app_box_clients (
  box_id         TEXT        PRIMARY KEY CHECK (box_id ~ '^abx_[0-9a-z]{8,40}$'),
  org_id         TEXT        NOT NULL,
  client_id      TEXT        NOT NULL UNIQUE CHECK (client_id ~ '^cli_[0-9a-f]{16}$'),
  secret_sealed  TEXT        NOT NULL CHECK (secret_sealed LIKE 'vault.%' OR secret_sealed LIKE 'bao.%'),
  redirect_uri   TEXT        NOT NULL CHECK (char_length(redirect_uri) <= 300),
  created_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);

CREATE TABLE app_gateway_sessions (
  id_hash     TEXT        PRIMARY KEY CHECK (id_hash ~ '^[0-9a-f]{64}$'),
  box_id      TEXT        NOT NULL CHECK (box_id ~ '^abx_[0-9a-z]{8,40}$'),
  org_id      TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  email       TEXT        NOT NULL CHECK (char_length(email) <= 320),
  name        TEXT        CHECK (name IS NULL OR char_length(name) <= 200),
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX app_gateway_sessions_box_idx ON app_gateway_sessions (box_id);
CREATE INDEX app_gateway_sessions_expiry_idx ON app_gateway_sessions (expires_at);

CREATE TABLE app_identity_keys (
  kid             TEXT        PRIMARY KEY CHECK (kid ~ '^aik_[0-9a-f]{16}$'),
  public_jwk      JSONB       NOT NULL,
  private_sealed  TEXT        NOT NULL CHECK (private_sealed LIKE 'vault.%' OR private_sealed LIKE 'bao.%'),
  created_at      TIMESTAMPTZ NOT NULL,
  retired_at      TIMESTAMPTZ
);
