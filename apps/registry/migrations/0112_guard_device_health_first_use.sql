UPDATE guard_devices SET health = health - 'policyKey' WHERE health->'policyKey'->>'pinned' = 'first-use';
