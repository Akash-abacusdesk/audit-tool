-- S2-D2 privileged admin auth (owner: apps/api; pam-mt3xnzu6).
-- Sessions gain a step-up timestamp: privileged routes require a fresh
-- password re-proof recorded here (docs/security/privileged-admin-auth.md §1).
ALTER TABLE api_sessions ADD COLUMN step_up_at timestamptz;
