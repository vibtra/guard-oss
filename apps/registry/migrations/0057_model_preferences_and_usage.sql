CREATE TABLE org_model_preferences (
  org_id      TEXT        NOT NULL REFERENCES orgs (org_id),
  person      TEXT        NOT NULL,
  model_id    TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, person)
);

CREATE TABLE org_model_usage (
  org_id              TEXT             NOT NULL REFERENCES orgs (org_id),
  person              TEXT             NOT NULL,
  project_id          TEXT             NOT NULL,
  session_id          TEXT             NOT NULL,
  turn_id             TEXT             NOT NULL,
  model_id            TEXT             NOT NULL,
  provider            TEXT,
  day                 DATE             NOT NULL,
  at                  TIMESTAMPTZ      NOT NULL,
  input_tokens        BIGINT           NOT NULL CHECK (input_tokens >= 0),
  output_tokens       BIGINT           NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens   BIGINT           NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens  BIGINT           NOT NULL CHECK (cache_write_tokens >= 0),
  cost_usd            DOUBLE PRECISION NOT NULL CHECK (cost_usd >= 0),
  PRIMARY KEY (org_id, session_id, turn_id)
);

CREATE INDEX org_model_usage_org_day ON org_model_usage (org_id, day);
CREATE INDEX org_model_usage_org_person_day ON org_model_usage (org_id, person, day);

CREATE TRIGGER org_model_usage_append_only
  BEFORE UPDATE OR DELETE ON org_model_usage
  FOR EACH ROW EXECUTE FUNCTION vibtra_append_only();
