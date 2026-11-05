ALTER TABLE builder_requests ADD COLUMN routing JSONB;
ALTER TABLE builder_requests ADD COLUMN decided_via TEXT;
ALTER TABLE builder_requests ADD COLUMN decided_override BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE builder_requests ADD COLUMN slack_card JSONB;
