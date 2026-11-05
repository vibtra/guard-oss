ALTER TABLE policy_requests DROP CONSTRAINT policy_requests_kind_check;
ALTER TABLE policy_requests ADD CONSTRAINT policy_requests_kind_check
  CHECK (kind IN ('package', 'egress-host', 'connector', 'model', 'policy-change', 'package-registry', 'image-change', 'spending-cap', 'plan', 'app-promote'));
