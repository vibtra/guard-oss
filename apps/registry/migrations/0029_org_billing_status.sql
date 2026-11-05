ALTER TABLE orgs ADD COLUMN billing_status    TEXT NOT NULL DEFAULT 'active';
ALTER TABLE orgs ADD COLUMN billing_status_at TIMESTAMPTZ;
