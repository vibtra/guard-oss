ALTER TABLE orgs ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waitlisted'));
ALTER TABLE orgs ADD COLUMN admitted_at TIMESTAMPTZ;
CREATE INDEX orgs_waitlisted_idx ON orgs (created_at) WHERE status = 'waitlisted';
