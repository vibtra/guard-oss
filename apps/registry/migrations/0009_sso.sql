CREATE TABLE "ssoProvider" (
  "id"             TEXT        PRIMARY KEY,
  "issuer"         TEXT        NOT NULL,
  "oidcConfig"     TEXT,
  "samlConfig"     TEXT,
  "userId"         TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "providerId"     TEXT        NOT NULL UNIQUE,
  "organizationId" TEXT        REFERENCES "organization"("id") ON DELETE CASCADE,
  "domain"         TEXT        NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ba_sso_provider_org_idx    ON "ssoProvider" ("organizationId");
CREATE INDEX ba_sso_provider_domain_idx ON "ssoProvider" ("domain");
