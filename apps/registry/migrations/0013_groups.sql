CREATE TABLE "team" (
  "id"             TEXT        PRIMARY KEY,
  "name"           TEXT        NOT NULL,
  "memberCount"    INTEGER     NOT NULL DEFAULT 0,
  "organizationId" TEXT        NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "createdAt"      TIMESTAMPTZ NOT NULL,
  "updatedAt"      TIMESTAMPTZ,
  "createdBy"      TEXT
);
CREATE INDEX ba_team_org_idx ON "team" ("organizationId");

CREATE TABLE "teamMember" (
  "id"            TEXT        PRIMARY KEY,
  "teamId"        TEXT        NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
  "userId"        TEXT        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "membershipKey" TEXT        UNIQUE,
  "createdAt"     TIMESTAMPTZ
);
CREATE INDEX ba_team_member_team_idx ON "teamMember" ("teamId");
CREATE INDEX ba_team_member_user_idx ON "teamMember" ("userId");

ALTER TABLE "session"    ADD COLUMN "activeTeamId" TEXT;
ALTER TABLE "invitation" ADD COLUMN "teamId"       TEXT;
