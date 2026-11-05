CREATE TABLE usage_snapshots (
  org_id      TEXT    NOT NULL REFERENCES orgs (org_id),
  day         DATE    NOT NULL,
  seats       INTEGER NOT NULL,
  connections INTEGER NOT NULL,
  live_tools  INTEGER NOT NULL,
  deploys     INTEGER NOT NULL,
  PRIMARY KEY (org_id, day)
);

CREATE TRIGGER usage_snapshots_append_only
  BEFORE UPDATE OR DELETE ON usage_snapshots
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();
