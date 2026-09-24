-- 009_secrets_staging_deepaudit.sql : promote the S11/S14/S15 in-memory D1
-- mocks to durable PostgreSQL storage (per db-conventions.md §4, api_ prefix).
--
-- These stores were intentionally shipped as in-memory stubs ("swap for a PG
-- table when promoted past CI mocks" — see the code they replace). Each row
-- carries its structured state as jsonb rather than fully normalized columns:
-- these are D1-owned application state blobs (scoped secrets, staging
-- lifecycle, deep-audit run/report), not cross-service queryable entities.
--
-- Vaultwarden secrets never land here — assertNotDirectVaultwarden refuses
-- any vaultwarden:-prefixed key before a write reaches this table.

CREATE TABLE IF NOT EXISTS api_secrets (
  scope_key   text NOT NULL,
  key         text NOT NULL,
  org_id      uuid NOT NULL,
  project_id  uuid,
  environment_id uuid,
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key, key)
);

CREATE TABLE IF NOT EXISTS api_staging_runs (
  id             uuid PRIMARY KEY,
  project_id     uuid NOT NULL,
  environment_id uuid NOT NULL,
  ref            text NOT NULL,
  state          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_deep_audit_runs (
  id          uuid PRIMARY KEY,
  target      jsonb NOT NULL,
  state       jsonb,
  report      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
