ALTER TABLE orgs
  ADD COLUMN stripe_customer_id           TEXT,
  ADD COLUMN stripe_subscription_id       TEXT,
  ADD COLUMN stripe_subscription_status   TEXT,
  ADD COLUMN stripe_price_id              TEXT,
  ADD COLUMN stripe_current_period_end    TIMESTAMPTZ,
  ADD COLUMN stripe_cancel_at_period_end  BOOLEAN,
  ADD COLUMN stripe_seats                 INT,
  ADD COLUMN stripe_state_at              TIMESTAMPTZ;

CREATE TABLE billing_events (
  event_id        TEXT        PRIMARY KEY,
  org_id          TEXT,
  type            TEXT        NOT NULL,
  stripe_created  TIMESTAMPTZ NOT NULL,
  livemode        BOOLEAN     NOT NULL,
  outcome         TEXT        NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX billing_events_org_idx ON billing_events (org_id, received_at DESC);

CREATE TRIGGER billing_events_append_only
  BEFORE UPDATE OR DELETE ON billing_events
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();
