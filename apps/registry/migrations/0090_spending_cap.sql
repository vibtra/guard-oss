CREATE TABLE spending_caps (
  org_id               TEXT        PRIMARY KEY,
  cap_cents            INT         CHECK (cap_cents IS NULL OR cap_cents >= 0),
  explicit_unlimited   BOOLEAN     NOT NULL DEFAULT false,
  set_by               TEXT        NOT NULL,
  set_at               TIMESTAMPTZ NOT NULL,
  CHECK (cap_cents IS NOT NULL OR explicit_unlimited)
);

ALTER TABLE orgs ADD COLUMN stripe_metered_subscription_id TEXT;

ALTER TABLE policy_requests DROP CONSTRAINT policy_requests_kind_check;
ALTER TABLE policy_requests ADD CONSTRAINT policy_requests_kind_check
  CHECK (kind IN ('package', 'egress-host', 'connector', 'model', 'policy-change', 'package-registry', 'image-change', 'spending-cap', 'plan'));
