ALTER TABLE app_boxes ADD COLUMN last_wake_kind TEXT CHECK (last_wake_kind IS NULL OR last_wake_kind IN ('pool', 'cold'));
