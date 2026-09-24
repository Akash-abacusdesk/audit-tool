-- 010_update_units.sql : Section-13 Safe WordPress Update Engine (S13-D1)
-- One component/dependency group updated at a time; the state machine
-- (packages/shared/src/update-state.ts) is the single source of allowed
-- transitions. This table just persists which state each unit is in.

CREATE TABLE IF NOT EXISTS api_update_units (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL,
  environment_id uuid NOT NULL,
  component      text NOT NULL,
  from_version   text NOT NULL,
  to_version     text NOT NULL,
  state          text NOT NULL DEFAULT 'discovered',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_update_units_project_idx ON api_update_units (project_id, state);
