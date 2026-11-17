ALTER TABLE guard_org_signing_keys ADD COLUMN backend TEXT NOT NULL DEFAULT 'local';
ALTER TABLE guard_org_signing_keys ADD COLUMN key_ref TEXT;
ALTER TABLE guard_org_signing_keys ALTER COLUMN sealed_private_key DROP NOT NULL;
ALTER TABLE guard_org_signing_keys ADD CONSTRAINT guard_org_signing_keys_backend_material CHECK (
  CASE WHEN backend = 'local' THEN sealed_private_key IS NOT NULL AND key_ref IS NULL ELSE sealed_private_key IS NULL AND key_ref IS NOT NULL END
);
