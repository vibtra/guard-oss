CREATE TABLE "user" (
  "id"            TEXT        PRIMARY KEY,
  "name"          TEXT        NOT NULL,
  "email"         TEXT        NOT NULL UNIQUE,
  "emailVerified" BOOLEAN     NOT NULL DEFAULT FALSE,
  "image"         TEXT,
  "hostedDomain"  TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "session" (
  "id"                    TEXT        PRIMARY KEY,
  "expiresAt"             TIMESTAMPTZ NOT NULL,
  "token"                 TEXT        NOT NULL UNIQUE,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMPTZ NOT NULL,
  "ipAddress"             TEXT,
  "userAgent"             TEXT,
  "userId"                TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "activeOrganizationId"  TEXT
);
CREATE INDEX ba_session_user_idx ON "session" ("userId");

CREATE TABLE "account" (
  "id"                    TEXT        PRIMARY KEY,
  "issuer"                TEXT        NOT NULL,
  "accountId"             TEXT        NOT NULL,
  "providerId"            TEXT        NOT NULL,
  "userId"                TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken"           TEXT,
  "refreshToken"          TEXT,
  "idToken"               TEXT,
  "accessTokenExpiresAt"  TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  "scope"                 TEXT,
  "password"              TEXT,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMPTZ NOT NULL
);
CREATE INDEX ba_account_user_idx ON "account" ("userId");

CREATE TABLE "verification" (
  "id"         TEXT        PRIMARY KEY,
  "identifier" TEXT        NOT NULL,
  "value"      TEXT        NOT NULL,
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ba_verification_identifier_idx ON "verification" ("identifier");

CREATE TABLE "organization" (
  "id"        TEXT        PRIMARY KEY,
  "name"      TEXT        NOT NULL,
  "slug"      TEXT        NOT NULL UNIQUE,
  "logo"      TEXT,
  "metadata"  TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "member" (
  "id"             TEXT        PRIMARY KEY,
  "organizationId" TEXT        NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "userId"         TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role"           TEXT        NOT NULL DEFAULT 'member',
  "createdAt"      TIMESTAMPTZ NOT NULL,
  UNIQUE ("organizationId", "userId")
);
CREATE INDEX ba_member_org_idx  ON "member" ("organizationId");
CREATE INDEX ba_member_user_idx ON "member" ("userId");

CREATE TABLE "invitation" (
  "id"             TEXT        PRIMARY KEY,
  "organizationId" TEXT        NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email"          TEXT        NOT NULL,
  "role"           TEXT,
  "status"         TEXT        NOT NULL DEFAULT 'pending',
  "expiresAt"      TIMESTAMPTZ NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "inviterId"      TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX ba_invitation_org_idx ON "invitation" ("organizationId");
