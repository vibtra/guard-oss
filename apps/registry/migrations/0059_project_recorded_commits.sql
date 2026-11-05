ALTER TABLE org_projects ADD COLUMN recorded_commits text[] NOT NULL DEFAULT '{}';
