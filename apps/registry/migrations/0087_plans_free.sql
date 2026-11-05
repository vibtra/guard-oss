ALTER TABLE orgs ALTER COLUMN plan SET DEFAULT 'free';

INSERT INTO vault_audit (audit_id, org_id, at, event, actor_kind, actor, outcome, detail)
  SELECT
    'vau_mig0087_' || org_id,
    org_id,
    now(),
    'plan.migrated',
    'admin',
    'migration 0087',
    'allowed',
    'plan team → free (migration 0087, DECISIONS.md m3-4: no paid subscription, and the trial is gone)'
  FROM orgs
  WHERE plan = 'team' AND stripe_subscription_id IS NULL;

UPDATE orgs SET plan = 'free' WHERE plan = 'team' AND stripe_subscription_id IS NULL;
