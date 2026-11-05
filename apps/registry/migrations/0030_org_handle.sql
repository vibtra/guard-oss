ALTER TABLE orgs ADD COLUMN handle TEXT;

WITH folded AS (
  SELECT
    o.org_id,
    o.created_at,
    CASE WHEN length(s.seed) < 2 THEN s.seed || '-org' ELSE s.seed END AS seed
  FROM orgs o
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      NULLIF(
        trim(BOTH '-' FROM substring(
          regexp_replace(
            lower(split_part(split_part(COALESCE(NULLIF(o.domain, ''), o.name), '@', 1), '.', 1)),
            '[^a-z0-9]+', '-', 'g'
          ) FROM 1 FOR 39
        )),
        ''
      ),
      'org'
    ) AS seed
  ) s
), ranked AS (
  SELECT
    f.org_id,
    f.seed,
    ROW_NUMBER() OVER (PARTITION BY f.seed ORDER BY f.created_at, f.org_id)
      + CASE WHEN f.seed IN (
          'login','signin','app','assets','accept-invitation',
          'connections','tokens',
          'api','auth','oauth2','.well-known','scim','mcp',
          'r','v1','tools','healthz','billing',
          'pricing','docs','admin','www'
        ) THEN 1 ELSE 0 END AS n
  FROM folded f
)
UPDATE orgs o
SET handle = CASE
  WHEN r.n = 1 THEN r.seed
  ELSE trim(BOTH '-' FROM substring(r.seed FROM 1 FOR 39 - length('-' || r.n::text))) || '-' || r.n::text
END
FROM ranked r
WHERE r.org_id = o.org_id;

ALTER TABLE orgs ALTER COLUMN handle SET NOT NULL;

CREATE UNIQUE INDEX orgs_handle ON orgs (handle);

CREATE TABLE org_handle_aliases (
  handle     TEXT        PRIMARY KEY,
  org_id     TEXT        NOT NULL REFERENCES orgs (org_id),
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX org_handle_aliases_org ON org_handle_aliases (org_id);
