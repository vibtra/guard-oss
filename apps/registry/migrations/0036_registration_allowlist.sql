CREATE TABLE registration_allowlist (
  id         TEXT        PRIMARY KEY,
  subject    TEXT        NOT NULL UNIQUE,
  kind       TEXT        NOT NULL CHECK (kind IN ('email', 'domain')),
  note       TEXT,
  added_by   TEXT        NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX registration_allowlist_by_added_at ON registration_allowlist (added_at DESC);
