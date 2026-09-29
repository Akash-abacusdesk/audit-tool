-- 013_notification_outbox.sql : S9 durable outbound-notification queue
-- (PRD §16). Nothing sends directly to Telegram from a request handler --
-- callers insert a row here and enqueue a 'notification' job; the scheduler
-- worker sends it and records the outcome. dedupe_key prevents re-alerting
-- on the same event (e.g. the same finding fingerprint) across re-scans.

CREATE TABLE IF NOT EXISTS notification_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  text NOT NULL,
  channel     text NOT NULL DEFAULT 'telegram',
  bot_id      text NOT NULL,
  chat_id     text NOT NULL,
  body        text NOT NULL,
  dedupe_key  text,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_outbox_dedupe
  ON notification_outbox (channel, bot_id, chat_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_notification_outbox_status
  ON notification_outbox (status, created_at);
