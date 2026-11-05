ALTER TABLE org_connections ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'static';
ALTER TABLE org_connections ADD COLUMN dynamic_config JSONB;

ALTER TABLE org_tools ADD COLUMN database_leases JSONB;
