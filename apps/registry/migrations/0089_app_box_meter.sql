CREATE TABLE app_boxes (
  id          TEXT        PRIMARY KEY,
  org_id      TEXT        NOT NULL,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  status      TEXT        NOT NULL CHECK (status IN ('awake', 'asleep', 'stopped', 'deleted')),
  storage_gb  INT         NOT NULL CHECK (storage_gb >= 0),
  created_at  TIMESTAMPTZ NOT NULL,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX app_boxes_org_idx ON app_boxes (org_id);

CREATE TABLE app_box_intervals (
  box_id      TEXT        NOT NULL REFERENCES app_boxes (id),
  org_id      TEXT        NOT NULL,
  awake_from  TIMESTAMPTZ NOT NULL,
  awake_to    TIMESTAMPTZ
);
CREATE INDEX app_box_intervals_org_idx ON app_box_intervals (org_id, awake_from);
CREATE UNIQUE INDEX app_box_intervals_one_open ON app_box_intervals (box_id) WHERE awake_to IS NULL;
