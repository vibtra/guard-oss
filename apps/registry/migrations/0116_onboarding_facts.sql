ALTER TABLE orgs ADD COLUMN chase_after_days INTEGER NOT NULL DEFAULT 7 CHECK (chase_after_days BETWEEN 1 AND 365);

ALTER TABLE "invitation" ADD COLUMN "lastSentAt" TIMESTAMPTZ;

ALTER TABLE guard_devices ADD COLUMN ca_trusted_at TIMESTAMPTZ;
ALTER TABLE guard_devices ADD COLUMN extension_approved_at TIMESTAMPTZ;
ALTER TABLE guard_devices ADD COLUMN integrity_failed_at TIMESTAMPTZ;

UPDATE guard_devices SET ca_trusted_at = COALESCE(last_seen_at, enrolled_at) WHERE health->>'caTrusted' = 'true';
UPDATE guard_devices SET extension_approved_at = COALESCE(last_seen_at, enrolled_at) WHERE health->>'extensionActive' = 'true';
