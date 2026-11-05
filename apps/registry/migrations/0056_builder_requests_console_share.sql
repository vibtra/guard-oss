ALTER TABLE builder_requests ADD COLUMN raised_by TEXT NOT NULL DEFAULT 'engine';
ALTER TABLE builder_requests ADD COLUMN share_audience JSONB;
ALTER TABLE builder_requests ADD COLUMN share_deploy_id TEXT;

DROP INDEX IF EXISTS builder_requests_resume;
CREATE INDEX builder_requests_resume ON builder_requests (org_id, session_id)
  WHERE status <> 'pending' AND resume_acked_at IS NULL AND raised_by <> 'console';
