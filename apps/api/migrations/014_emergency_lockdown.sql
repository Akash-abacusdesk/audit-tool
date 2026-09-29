-- 014_emergency_lockdown.sql : S16 runbook action 5 — a single atomic switch
-- to stop production/update/new-JIT actions during a management-host
-- compromise, without also blocking the JIT REVOKE calls the same incident
-- response needs (see docs/security/compromise-response-runbook.md).
-- Singleton row (id always true) — one platform-wide flag, read fresh on
-- every gated request (no cache), matching the existing fresh-RBAC pattern
-- used by Telegram/JIT authorization.

CREATE TABLE IF NOT EXISTS emergency_lockdown (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled     boolean NOT NULL DEFAULT false,
  reason      text,
  enabled_by  uuid,
  enabled_at  timestamptz,
  disabled_by uuid,
  disabled_at timestamptz
);

INSERT INTO emergency_lockdown (id, enabled) VALUES (true, false)
  ON CONFLICT (id) DO NOTHING;
