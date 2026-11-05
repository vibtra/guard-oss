ALTER TABLE vault_audit DROP CONSTRAINT IF EXISTS vault_audit_actor_kind_check;
ALTER TABLE vault_audit
  ADD CONSTRAINT vault_audit_actor_kind_check CHECK (actor_kind IN ('admin', 'door', 'member'));
