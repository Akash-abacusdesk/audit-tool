-- S9-D1: Telegram ops callback control plane
-- Telegram authorization allow-list (per chat/user) + replay-safe callback log.
-- Tables intentionally NOT api_-prefixed to stay consistent with the S8 WP/JIT
-- plane (wp_events, jit_requests, ...) which owns the same webhook-style shape.

CREATE TABLE IF NOT EXISTS telegram_authorizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        text NOT NULL,
  chat_id       text NOT NULL,
  user_id       text NOT NULL,
  actions       text[] NOT NULL,
  org_id        uuid,
  project_id    uuid,
  environment_id uuid,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  UNIQUE (bot_id, chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS telegram_callbacks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id      text NOT NULL,
  delivery_id text NOT NULL,
  chat_id     text NOT NULL,
  user_id     text NOT NULL,
  action      text NOT NULL,
  occurred_at timestamptz NOT NULL,
  request_id  text,
  details     jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS ix_telegram_callbacks_received
  ON telegram_callbacks (received_at);
CREATE INDEX IF NOT EXISTS ix_telegram_authz_bot
  ON telegram_authorizations (bot_id, revoked_at);
