CREATE FUNCTION vibtra_plan_seats(plan TEXT) RETURNS INT
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE plan
      WHEN 'team' THEN 25
      WHEN 'business' THEN 100
      WHEN 'enterprise' THEN NULL
      ELSE 5
    END
  $$;

CREATE TABLE org_seats (
  org_id      TEXT        PRIMARY KEY REFERENCES orgs (org_id) ON DELETE CASCADE,
  seats       INT         NULL CHECK (seats IS NULL OR seats >= 0),
  source      TEXT        NOT NULL CHECK (source IN ('override', 'subscription', 'plan')),
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE FUNCTION vibtra_recompute_org_seats(target TEXT) RETURNS VOID
  LANGUAGE sql
  AS $$
    INSERT INTO org_seats (org_id, seats, source, updated_at)
    SELECT o.org_id,
           CASE
             WHEN o.user_limit IS NOT NULL THEN o.user_limit
             WHEN o.stripe_subscription_id IS NOT NULL AND o.stripe_seats IS NOT NULL
                  AND o.stripe_subscription_status IN ('active', 'trialing', 'past_due') THEN o.stripe_seats
             ELSE vibtra_plan_seats(o.plan)
           END,
           CASE
             WHEN o.user_limit IS NOT NULL THEN 'override'
             WHEN o.stripe_subscription_id IS NOT NULL AND o.stripe_seats IS NOT NULL
                  AND o.stripe_subscription_status IN ('active', 'trialing', 'past_due') THEN 'subscription'
             ELSE 'plan'
           END,
           now()
      FROM orgs o
     WHERE o.org_id = target
    ON CONFLICT (org_id) DO UPDATE
       SET seats = EXCLUDED.seats, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
  $$;

CREATE FUNCTION vibtra_org_seats_follow() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    PERFORM vibtra_recompute_org_seats(NEW.org_id);
    RETURN NULL;
  END
  $$;

CREATE TRIGGER orgs_seats_on_create
  AFTER INSERT ON orgs
  FOR EACH ROW EXECUTE FUNCTION vibtra_org_seats_follow();

CREATE TRIGGER orgs_seats_on_change
  AFTER UPDATE OF plan, user_limit, stripe_seats, stripe_subscription_id, stripe_subscription_status ON orgs
  FOR EACH ROW EXECUTE FUNCTION vibtra_org_seats_follow();

CREATE VIEW org_open_seats AS
  SELECT s.org_id,
         s.seats,
         s.source,
         m.members,
         CASE WHEN s.seats IS NULL THEN NULL ELSE s.seats - m.members END AS open_seats
    FROM org_seats s
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS members FROM "member" WHERE "organizationId" = s.org_id
    ) m;

SELECT vibtra_recompute_org_seats(org_id) FROM orgs;
