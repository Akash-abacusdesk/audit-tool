-- S2-D2: append-only enforcement for the audit trail at the GRANT level
-- (docs/security/privileged-admin-auth.md §3). Apply ON SERVERS with a
-- dedicated runtime role; dev compose runs as owner and skips this.
-- Idempotent; run as superuser via psql after first migrate.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN PASSWORD 'set-via-secret-injection';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, platform TO platform_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_app;

-- The audit trail is INSERT/SELECT only — no UPDATE/DELETE, ever:
REVOKE UPDATE, DELETE, TRUNCATE ON api_audit_events FROM platform_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE UPDATE, DELETE, TRUNCATE ON TABLES FROM platform_app;

-- platform.schema_migrations stays writable for the migration runner only.
