INSERT INTO vault_audit (audit_id, org_id, at, event, actor_kind, actor, outcome, detail)
  SELECT
    'vau_mig0034_' || org_id,
    org_id,
    now(),
    'plan.migrated',
    'admin',
    'migration 0034',
    'allowed',
    'plan ' || plan || ' → ' || CASE plan
        WHEN 'entry'     THEN 'team'
        WHEN 'team-25'   THEN 'team'
        WHEN 'team-100'  THEN 'business'
        WHEN 'unlimited' THEN 'enterprise'
      END
      || ' (migration 0034, DECISIONS.md pay-15)'
  FROM orgs
  WHERE plan IN ('entry', 'team-25', 'team-100', 'unlimited');

UPDATE orgs SET plan = CASE plan
    WHEN 'entry'     THEN 'team'
    WHEN 'team-25'   THEN 'team'
    WHEN 'team-100'  THEN 'business'
    WHEN 'unlimited' THEN 'enterprise'
  END
  WHERE plan IN ('entry', 'team-25', 'team-100', 'unlimited');

ALTER TABLE orgs ADD COLUMN trial_ends_at TIMESTAMPTZ;

ALTER TABLE orgs ADD COLUMN design_partner_until        DATE;
ALTER TABLE orgs ADD COLUMN design_partner_discount_pct INTEGER;
ALTER TABLE orgs ADD CONSTRAINT orgs_design_partner_whole CHECK (
  (design_partner_until IS NULL     AND design_partner_discount_pct IS NULL)
  OR
  (design_partner_until IS NOT NULL AND design_partner_discount_pct IS NOT NULL
                                    AND design_partner_discount_pct BETWEEN 0 AND 100)
);
