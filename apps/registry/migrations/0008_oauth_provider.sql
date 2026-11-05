CREATE TABLE "jwks" (
  "id"         TEXT        PRIMARY KEY,
  "publicKey"  TEXT        NOT NULL,
  "privateKey" TEXT        NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL,
  "expiresAt"  TIMESTAMPTZ,
  "alg"        TEXT,
  "crv"        TEXT
);

CREATE TABLE "oauthClient" (
  "id"                               TEXT        PRIMARY KEY,
  "clientId"                         TEXT        NOT NULL UNIQUE,
  "clientSecret"                     TEXT,
  "clientDiscoveryId"                TEXT,
  "disabled"                         BOOLEAN     DEFAULT FALSE,
  "skipConsent"                      BOOLEAN,
  "enableEndSession"                 BOOLEAN,
  "subjectType"                      TEXT,
  "scopes"                           JSONB,
  "clientCredentialsScopes"          JSONB,
  "userId"                           TEXT        REFERENCES "user"("id") ON DELETE CASCADE,
  "createdAt"                        TIMESTAMPTZ,
  "updatedAt"                        TIMESTAMPTZ,
  "name"                             TEXT,
  "uri"                              TEXT,
  "icon"                             TEXT,
  "contacts"                         JSONB,
  "tos"                              TEXT,
  "policy"                           TEXT,
  "softwareId"                       TEXT,
  "softwareVersion"                  TEXT,
  "softwareStatement"                TEXT,
  "redirectUris"                     JSONB       NOT NULL,
  "postLogoutRedirectUris"           JSONB,
  "backchannelLogoutUri"             TEXT,
  "backchannelLogoutSessionRequired" BOOLEAN,
  "tokenEndpointAuthMethod"          TEXT,
  "applicationType"                  TEXT,
  "jwks"                             TEXT,
  "jwksUri"                          TEXT,
  "grantTypes"                       JSONB,
  "responseTypes"                    JSONB,
  "requirePKCE"                      BOOLEAN,
  "dpopBoundAccessTokens"            BOOLEAN     DEFAULT FALSE,
  "referenceId"                      TEXT,
  "metadata"                         JSONB
);
CREATE INDEX ba_oauth_client_user_idx ON "oauthClient" ("userId");

CREATE TABLE "oauthResource" (
  "id"                            TEXT        PRIMARY KEY,
  "identifier"                    TEXT        NOT NULL UNIQUE,
  "name"                          TEXT        NOT NULL,
  "accessTokenTtl"                INTEGER,
  "refreshTokenTtl"               INTEGER,
  "signingAlgorithm"              TEXT,
  "signingKeyId"                  TEXT,
  "allowedScopes"                 JSONB,
  "customClaims"                  JSONB,
  "dpopBoundAccessTokensRequired" BOOLEAN     DEFAULT FALSE,
  "disabled"                      BOOLEAN     DEFAULT FALSE,
  "createdAt"                     TIMESTAMPTZ,
  "updatedAt"                     TIMESTAMPTZ,
  "policyVersion"                 INTEGER     DEFAULT 1,
  "metadata"                      JSONB
);

CREATE TABLE "oauthClientResource" (
  "id"         TEXT        PRIMARY KEY,
  "clientId"   TEXT        NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "resourceId" TEXT        NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMPTZ,
  UNIQUE ("clientId", "resourceId")
);
CREATE INDEX ba_oauth_client_resource_client_idx   ON "oauthClientResource" ("clientId");
CREATE INDEX ba_oauth_client_resource_resource_idx ON "oauthClientResource" ("resourceId");

CREATE TABLE "oauthRefreshToken" (
  "id"                       TEXT        PRIMARY KEY,
  "token"                    TEXT        NOT NULL UNIQUE,
  "clientId"                 TEXT        NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId"                TEXT        REFERENCES "session"("id") ON DELETE SET NULL,
  "userId"                   TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "referenceId"              TEXT,
  "authorizationCodeId"      TEXT,
  "resources"                JSONB,
  "requestedUserInfoClaims"  JSONB,
  "expiresAt"                TIMESTAMPTZ,
  "createdAt"                TIMESTAMPTZ,
  "revoked"                  TIMESTAMPTZ,
  "rotatedAt"                TIMESTAMPTZ,
  "rotationReplayResponse"   TEXT,
  "rotationReplayExpiresAt"  TIMESTAMPTZ,
  "authTime"                 TIMESTAMPTZ,
  "confirmation"             JSONB,
  "scopes"                   JSONB       NOT NULL
);
CREATE INDEX ba_oauth_refresh_client_idx  ON "oauthRefreshToken" ("clientId");
CREATE INDEX ba_oauth_refresh_session_idx ON "oauthRefreshToken" ("sessionId");
CREATE INDEX ba_oauth_refresh_user_idx    ON "oauthRefreshToken" ("userId");
CREATE INDEX ba_oauth_refresh_code_idx    ON "oauthRefreshToken" ("authorizationCodeId");

CREATE TABLE "oauthAccessToken" (
  "id"                      TEXT        PRIMARY KEY,
  "token"                   TEXT        UNIQUE,
  "clientId"                TEXT        NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId"               TEXT        REFERENCES "session"("id") ON DELETE SET NULL,
  "userId"                  TEXT        REFERENCES "user"("id") ON DELETE CASCADE,
  "referenceId"             TEXT,
  "authorizationCodeId"     TEXT,
  "resources"               JSONB,
  "requestedUserInfoClaims" JSONB,
  "refreshId"               TEXT        REFERENCES "oauthRefreshToken"("id") ON DELETE CASCADE,
  "expiresAt"               TIMESTAMPTZ,
  "createdAt"               TIMESTAMPTZ,
  "revoked"                 TIMESTAMPTZ,
  "confirmation"            JSONB,
  "scopes"                  JSONB       NOT NULL
);
CREATE INDEX ba_oauth_access_client_idx  ON "oauthAccessToken" ("clientId");
CREATE INDEX ba_oauth_access_session_idx ON "oauthAccessToken" ("sessionId");
CREATE INDEX ba_oauth_access_user_idx    ON "oauthAccessToken" ("userId");
CREATE INDEX ba_oauth_access_code_idx    ON "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX ba_oauth_access_refresh_idx ON "oauthAccessToken" ("refreshId");

CREATE TABLE "oauthConsent" (
  "id"                      TEXT        PRIMARY KEY,
  "clientId"                TEXT        NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "userId"                  TEXT        REFERENCES "user"("id") ON DELETE CASCADE,
  "referenceId"             TEXT,
  "resources"               JSONB,
  "requestedUserInfoClaims" JSONB,
  "scopes"                  JSONB       NOT NULL,
  "createdAt"               TIMESTAMPTZ,
  "updatedAt"               TIMESTAMPTZ
);
CREATE INDEX ba_oauth_consent_client_idx ON "oauthConsent" ("clientId");
CREATE INDEX ba_oauth_consent_user_idx   ON "oauthConsent" ("userId");

CREATE TABLE "oauthClientAssertion" (
  "id"        TEXT        PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL
);
