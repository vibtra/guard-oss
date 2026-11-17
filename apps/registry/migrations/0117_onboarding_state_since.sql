ALTER TABLE guard_devices ADD COLUMN ca_trust_changed_at TIMESTAMPTZ;
ALTER TABLE guard_devices ADD COLUMN extension_changed_at TIMESTAMPTZ;

UPDATE guard_devices SET ca_trust_changed_at = ca_trusted_at WHERE health->>'caTrusted' = 'true';
UPDATE guard_devices SET extension_changed_at = extension_approved_at WHERE health->>'extensionActive' = 'true';
