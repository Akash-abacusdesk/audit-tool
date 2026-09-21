-- S2 auth/RBAC/audit tables (owner: apps/api; naming per docs/db-conventions.md §4).

CREATE TABLE api_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    display_name  text NOT NULL,
    password_hash text NOT NULL, -- scrypt, format: scrypt$N$r$p$salthex$hashhex
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_sessions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES api_users(id),
    token_hash text NOT NULL UNIQUE, -- sha256 hex of the bearer token
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_sessions_user_idx ON api_sessions (user_id);

CREATE TABLE api_orgs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    slug       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_projects (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid NOT NULL REFERENCES api_orgs(id),
    name       text NOT NULL,
    slug       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug)
);

CREATE TABLE api_environments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES api_projects(id),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE api_role_bindings (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES api_users(id),
    role           text NOT NULL CHECK (role IN (
        'manager', 'team_lead', 'project_coordinator', 'developer', 'security_admin')),
    org_id         uuid NOT NULL REFERENCES api_orgs(id),
    project_id     uuid REFERENCES api_projects(id),
    environment_id uuid REFERENCES api_environments(id),
    granted_by     uuid REFERENCES api_users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- an environment-scoped binding must name its parent project
    CHECK (environment_id IS NULL OR project_id IS NOT NULL)
);

-- NULL-safe uniqueness for the nested scope triple.
CREATE UNIQUE INDEX api_role_bindings_scope_uq ON api_role_bindings (
    user_id, role, org_id,
    COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX api_role_bindings_user_idx ON api_role_bindings (user_id);
CREATE INDEX api_role_bindings_org_idx ON api_role_bindings (org_id);

-- Centralized audit trail: one row per privileged action / authorization decision.
CREATE TABLE api_audit_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id       uuid REFERENCES api_users(id), -- null = system
    action         text NOT NULL,                 -- e.g. 'auth.login', 'role.grant'
    result         text NOT NULL CHECK (result IN ('allow', 'deny', 'error')),
    org_id         uuid,
    project_id     uuid,
    environment_id uuid,
    resource       text,
    request_id     text,
    details        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_audit_events_created_idx ON api_audit_events (created_at DESC);
CREATE INDEX api_audit_events_actor_idx ON api_audit_events (actor_id, created_at DESC);
