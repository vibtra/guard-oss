ALTER TABLE access_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool';

DROP INDEX IF EXISTS access_requests_one_open;
CREATE UNIQUE INDEX access_requests_one_open
  ON access_requests (org_id, kind, tool_id, requester_email)
  WHERE status = 'pending';
