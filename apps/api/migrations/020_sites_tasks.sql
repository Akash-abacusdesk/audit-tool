-- 020_sites_tasks.sql : sites with an owning team member, Telegram contact per user, and a durable task outbox.
--
-- A site is the thing an admin registers and a team member operates. It is 1:1 with a project (created together),
-- so everything already keyed by project_id - scans, findings, RBAC scopes - belongs to the site with no new joins.
-- Scan failures write Telegram alerts (notification_outbox) and a task (task_outbox) in the same transaction as the
-- scan record; the task is delivered to the task portal once its API is configured (tasks/portal.ts).

ALTER TABLE api_users ADD COLUMN IF NOT EXISTS telegram_chat_id text;

CREATE TABLE IF NOT EXISTS api_sites (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES api_orgs(id),
    project_id    uuid NOT NULL UNIQUE REFERENCES api_projects(id),
    name          text NOT NULL,
    url           text,
    owner_user_id uuid REFERENCES api_users(id) ON DELETE SET NULL,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_sites_org_idx ON api_sites (org_id);
CREATE INDEX IF NOT EXISTS api_sites_owner_idx ON api_sites (owner_user_id);

CREATE TABLE IF NOT EXISTS task_outbox (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id          uuid REFERENCES api_sites(id) ON DELETE SET NULL,
    assignee_user_id uuid REFERENCES api_users(id) ON DELETE SET NULL,
    kind             text NOT NULL,
    title            text NOT NULL,
    description      text NOT NULL DEFAULT '',
    payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key       text,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    external_id      text,
    attempts         integer NOT NULL DEFAULT 0,
    last_error       text,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz
);
-- One task per event: re-ingesting the same failed scan must not register it twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_outbox_dedupe ON task_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_task_outbox_due ON task_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_task_outbox_site ON task_outbox (site_id, created_at DESC);
