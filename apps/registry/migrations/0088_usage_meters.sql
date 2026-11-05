CREATE TABLE usage_periods (
  org_id                     TEXT        NOT NULL,
  meter                      TEXT        NOT NULL CHECK (meter IN ('session', 'appbox_awake', 'appbox_extra')),
  period_start               TIMESTAMPTZ NOT NULL,
  period_end                 TIMESTAMPTZ NOT NULL,
  plan                       TEXT        NOT NULL,
  included_minutes           INT,
  used_minutes               INT         NOT NULL DEFAULT 0 CHECK (used_minutes >= 0),
  reported_overage_minutes   INT         NOT NULL DEFAULT 0 CHECK (reported_overage_minutes >= 0),
  state                      TEXT        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  updated_at                 TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, meter, period_start)
);
CREATE INDEX usage_periods_month_idx ON usage_periods (meter, plan, period_start);

CREATE TABLE usage_reports (
  id                 TEXT        PRIMARY KEY,
  org_id             TEXT        NOT NULL,
  meter              TEXT        NOT NULL CHECK (meter IN ('session', 'appbox_awake', 'appbox_extra')),
  period_start       TIMESTAMPTZ NOT NULL,
  quantity           INT         NOT NULL CHECK (quantity >= 0),
  stripe_identifier  TEXT        NOT NULL UNIQUE,
  status             TEXT        NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts           INT         NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL,
  sent_at            TIMESTAMPTZ
);
CREATE INDEX usage_reports_org_idx ON usage_reports (org_id, meter, period_start);

CREATE TABLE usage_notices (
  org_id        TEXT        NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('cap80', 'cap100', 'hours80', 'hours100', 'quota-stop')),
  at            TIMESTAMPTZ NOT NULL,
  stop_at       TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,
  PRIMARY KEY (org_id, period_start, kind)
);
