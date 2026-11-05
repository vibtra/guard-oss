CREATE TABLE org_projects (
  org_id          TEXT        NOT NULL REFERENCES orgs (org_id),
  id              TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  owner_email     TEXT        NOT NULL,
  owner_person_id TEXT,
  kind            TEXT        NOT NULL CHECK (kind IN ('app', 'agent')),
  linked_repo     JSONB,
  head_commit     TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, id)
);

CREATE INDEX org_projects_by_org ON org_projects (org_id, created_at DESC);

CREATE TABLE builder_sessions (
  org_id      TEXT        NOT NULL REFERENCES orgs (org_id),
  session_id  TEXT        NOT NULL,
  project_id  TEXT        NOT NULL,
  person      TEXT        NOT NULL,
  base_commit TEXT,
  head_commit TEXT,
  outcome     TEXT        NOT NULL CHECK (outcome IN ('open', 'waiting', 'closed', 'expired', 'failed')),
  opened_at   TIMESTAMPTZ NOT NULL,
  closed_at   TIMESTAMPTZ,
  PRIMARY KEY (org_id, session_id),
  FOREIGN KEY (org_id, project_id) REFERENCES org_projects (org_id, id)
);

CREATE INDEX builder_sessions_by_project ON builder_sessions (org_id, project_id, opened_at DESC);
