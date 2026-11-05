ALTER TABLE "ssoProvider"
  ADD COLUMN "clientSecretKeyId" TEXT
  CONSTRAINT sso_provider_client_secret_key_id_shape
  CHECK ("clientSecretKeyId" IS NULL OR "clientSecretKeyId" ~ '^[0-9a-f]{12}$');
