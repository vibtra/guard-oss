CREATE TABLE attach_tickets (
  ticket_sha256       TEXT        PRIMARY KEY CHECK (ticket_sha256 ~ '^[0-9a-f]{64}$'),
  user_id             TEXT        NOT NULL,
  org_id              TEXT        NOT NULL,
  session_id          TEXT        NOT NULL CHECK (session_id ~ '^wss_[0-9a-f]{20}$'),
  console_session_id  TEXT        NOT NULL,
  origin              TEXT        NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attach_tickets_expires_idx ON attach_tickets (expires_at);

ALTER TABLE workspace_attachments ADD COLUMN client TEXT CHECK (client IS NULL OR client IN ('cli', 'web'));
