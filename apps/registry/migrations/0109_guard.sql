CREATE TABLE guard_signing_keys (
  slot TEXT PRIMARY KEY CHECK (slot = 'current'),
  key_id TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  sealed_private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE guard_enrol_links (
  token_sha256 TEXT PRIMARY KEY,
  token_prefix TEXT NOT NULL,
  org_id TEXT NOT NULL,
  person_user_id TEXT NOT NULL,
  person_email TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_device TEXT
);
CREATE INDEX guard_enrol_links_org ON guard_enrol_links (org_id, created_at DESC);

CREATE TABLE guard_devices (
  device_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  person_user_id TEXT NOT NULL,
  person_email TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  facts JSONB NOT NULL,
  ca JSONB NOT NULL,
  health JSONB,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  client_mode TEXT NOT NULL CHECK (client_mode IN ('monitor', 'enforce')),
  enrolled_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  last_postflight_at TIMESTAMPTZ,
  bundle_version INT CHECK (bundle_version IS NULL OR bundle_version >= 0),
  bundle_digest TEXT,
  catalogue_version TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT
);
CREATE INDEX guard_devices_org ON guard_devices (org_id, enrolled_at);

CREATE TABLE guard_rules (
  org_id TEXT PRIMARY KEY,
  version INT NOT NULL CHECK (version >= 0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE guard_settings (
  org_id TEXT PRIMARY KEY,
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE guard_catalogue_overrides (
  org_id TEXT PRIMARY KEY,
  overrides JSONB NOT NULL,
  version INT NOT NULL CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE guard_events (
  org_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  person_user_id TEXT NOT NULL,
  person_email TEXT NOT NULL,
  person_name TEXT,
  hostname TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('flow', 'content', 'agent')),
  action TEXT NOT NULL CHECK (action IN ('observed', 'allowed', 'blocked', 'asked', 'redirected', 'requested')),
  service_id TEXT,
  service_name TEXT,
  host TEXT,
  port INT,
  method TEXT,
  path_hint TEXT CHECK (path_hint IS NULL OR length(path_hint) <= 40),
  app JSONB,
  rule_id TEXT,
  rule_name TEXT,
  rule_kind TEXT CHECK (rule_kind IS NULL OR rule_kind IN ('service', 'content', 'default', 'exception')),
  match_type TEXT,
  match_count INT CHECK (match_count IS NULL OR match_count >= 0),
  snippet TEXT CHECK (snippet IS NULL OR length(snippet) <= 80),
  bytes BIGINT CHECK (bytes IS NULL OR bytes >= 0),
  request_id TEXT,
  bundle_version INT,
  reason TEXT,
  PRIMARY KEY (org_id, event_id)
);
CREATE INDEX guard_events_org_received ON guard_events (org_id, received_at DESC);
CREATE INDEX guard_events_org_device_received ON guard_events (org_id, device_id, received_at);
CREATE INDEX guard_events_org_occurred ON guard_events (org_id, occurred_at DESC, event_id DESC);

CREATE TRIGGER guard_events_append_only
  BEFORE UPDATE OR DELETE ON guard_events
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();
