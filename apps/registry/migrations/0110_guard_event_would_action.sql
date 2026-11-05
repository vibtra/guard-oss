ALTER TABLE guard_events ADD COLUMN would_action TEXT;
ALTER TABLE guard_events
  ADD CONSTRAINT guard_events_would_action_check CHECK (would_action IS NULL OR would_action IN ('blocked', 'asked')) NOT VALID;
