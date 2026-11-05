ALTER TABLE app_box_hosts DROP CONSTRAINT IF EXISTS app_box_hosts_reason_check;
ALTER TABLE app_box_hosts ADD CONSTRAINT app_box_hosts_reason_check
  CHECK (reason IS NULL OR reason IN ('gone', 'park', 'delete', 'moved', 'drain', 'failover', 'fenced', 'tier'));

ALTER TABLE workspace_hosts DROP CONSTRAINT IF EXISTS workspace_hosts_reason_check;
ALTER TABLE workspace_hosts ADD CONSTRAINT workspace_hosts_reason_check
  CHECK (reason IS NULL OR reason IN ('moved', 'drain', 'failover', 'gone', 'tier'));
