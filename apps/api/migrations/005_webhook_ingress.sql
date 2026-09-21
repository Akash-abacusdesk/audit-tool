-- 005_webhook_ingress — S3-D2 (pam): signed webhook ingress support.
-- Dedupe substrate already exists: api_webhook_events UNIQUE(connection_id,
-- delivery_id) from 004 is the replay-protection mechanism (INSERT .. ON
-- CONFLICT DO NOTHING -> duplicate -> 200 ok({duplicate:true})).
-- This migration adds only what retention needs: a plain received_at index so
-- the daily pg-boss prune (docs/security/webhook-ingress-replay.md §retention)
-- scans an index instead of the table. Forward-only, no data changes.

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON api_webhook_events (received_at);
