ALTER TABLE orgs ADD COLUMN closed_at   TIMESTAMPTZ;
ALTER TABLE orgs ADD COLUMN closed_by   TEXT;
ALTER TABLE orgs ADD COLUMN purge_after TIMESTAMPTZ;

CREATE INDEX orgs_purge_after ON orgs (purge_after) WHERE purge_after IS NOT NULL;
