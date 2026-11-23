ALTER TABLE guard_devices ADD COLUMN protection_revision BIGINT CHECK (protection_revision IS NULL OR protection_revision >= 0);
