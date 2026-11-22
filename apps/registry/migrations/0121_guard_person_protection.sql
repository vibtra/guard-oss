CREATE TABLE guard_person_protection (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'monitor', 'enforce')),
  revision BIGINT NOT NULL CHECK (revision >= 1),
  set_by TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE guard_protection_revision (
  org_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  default_revision BIGINT NOT NULL CHECK (default_revision >= 0 AND default_revision <= revision)
);

ALTER TABLE guard_devices DROP CONSTRAINT guard_devices_client_mode_check;
ALTER TABLE guard_devices ADD CONSTRAINT guard_devices_client_mode_check CHECK (client_mode IN ('off', 'monitor', 'enforce'));
