ALTER TABLE orgs ADD COLUMN chase_after_days INTEGER NOT NULL DEFAULT 7 CHECK (chase_after_days BETWEEN 1 AND 365);

ALTER TABLE "invitation" ADD COLUMN "lastSentAt" TIMESTAMPTZ;

ALTER TABLE "user" ADD COLUMN "firstSignInAt" TIMESTAMPTZ;
UPDATE "user" u SET "firstSignInAt" = COALESCE(
  (SELECT min(s."createdAt") FROM "session" s WHERE s."userId" = u."id"),
  CASE WHEN EXISTS (SELECT 1 FROM "member" m WHERE m."userId" = u."id") THEN u."createdAt" END
);

ALTER TABLE guard_devices ADD COLUMN ca_trusted_at TIMESTAMPTZ;
ALTER TABLE guard_devices ADD COLUMN extension_approved_at TIMESTAMPTZ;
ALTER TABLE guard_devices ADD COLUMN integrity_failed_at TIMESTAMPTZ;
ALTER TABLE guard_devices ADD COLUMN integrity_checked_at TIMESTAMPTZ;
ALTER TABLE guard_devices ADD CONSTRAINT guard_devices_integrity_failure_checked CHECK (integrity_failed_at IS NULL OR integrity_checked_at IS NOT NULL);

UPDATE guard_devices SET ca_trusted_at = enrolled_at WHERE health->>'caTrusted' = 'true';
UPDATE guard_devices SET extension_approved_at = enrolled_at WHERE health->>'extensionActive' = 'true';
