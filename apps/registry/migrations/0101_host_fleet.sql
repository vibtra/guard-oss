ALTER TABLE sandbox_hosts ADD COLUMN health JSONB;
ALTER TABLE sandbox_hosts ADD COLUMN health_at TIMESTAMPTZ;
ALTER TABLE sandbox_hosts ADD COLUMN capacity_slots INT CHECK (capacity_slots IS NULL OR capacity_slots >= 0);
ALTER TABLE sandbox_hosts ADD COLUMN drain_started_at TIMESTAMPTZ;
ALTER TABLE sandbox_hosts ADD COLUMN drain_deadline TIMESTAMPTZ;
ALTER TABLE sandbox_hosts ADD COLUMN failed_over_at TIMESTAMPTZ;

ALTER TABLE app_boxes ADD COLUMN lost_awake_at TIMESTAMPTZ;

ALTER TABLE app_box_hosts DROP CONSTRAINT IF EXISTS app_box_hosts_reason_check;
ALTER TABLE app_box_hosts ADD CONSTRAINT app_box_hosts_reason_check
  CHECK (reason IS NULL OR reason IN ('gone', 'park', 'delete', 'moved', 'drain', 'failover', 'fenced'));
