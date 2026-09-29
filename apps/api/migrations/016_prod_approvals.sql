-- 016_prod_approvals.sql : one-time, op-bound approvals for /prod/commands.
-- An approval names the exact op + target + scope, expires quickly, and is consumed
-- atomically by the command that uses it (no reuse, no substitution).
CREATE TABLE IF NOT EXISTS prod_approvals (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    op             text NOT NULL,
    target         text NOT NULL,
    org_id         uuid NOT NULL REFERENCES api_orgs(id),
    project_id     uuid REFERENCES api_projects(id),
    environment_id uuid REFERENCES api_environments(id),
    requested_by   uuid NOT NULL REFERENCES api_users(id),
    expires_at     timestamptz NOT NULL,
    consumed_at    timestamptz,
    consumed_by    uuid REFERENCES api_users(id),
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prod_approvals_open_idx ON prod_approvals (expires_at) WHERE consumed_at IS NULL;
