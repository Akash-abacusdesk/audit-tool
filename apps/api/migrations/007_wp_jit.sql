-- 007_wp_jit.sql : Section-8 WordPress event ingest + JIT privileged access (S8-D1)
-- Replay/forgery resistance for the WP event ingest lives in the application
-- (HMAC verify over raw body + advisory freshness window); the unique index
-- below is the authoritative dedup guarantee. JIT secrets are stored raw per
-- site because HMAC verification requires the raw key. Treat as sensitive.

CREATE TABLE IF NOT EXISTS wp_event_signing_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     text NOT NULL UNIQUE,
  secret      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE IF NOT EXISTS wp_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     text NOT NULL,
  delivery_id text NOT NULL,
  event_type  text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor       jsonb NOT NULL,
  request_id  text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS wp_events_site_idx ON wp_events (site_id, received_at DESC);

CREATE TABLE IF NOT EXISTS jit_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         text NOT NULL,
  reason          text NOT NULL,
  duration_minutes integer NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  token_issued_at timestamptz,
  expires_at      timestamptz
);
CREATE INDEX IF NOT EXISTS jit_requests_status_idx ON jit_requests (status, created_at DESC);

-- Opaque redemption tokens: only the SHA-256 is persisted; the raw token is
-- shown once at approval and never stored, so a DB read cannot replay a grant.
CREATE TABLE IF NOT EXISTS jit_tokens (
  token_hash   text PRIMARY KEY,
  request_id   uuid NOT NULL REFERENCES jit_requests (id),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at  timestamptz,
  expires_at   timestamptz NOT NULL
);

-- Active grant state. A request yields at most one grant (one-time redemption
-- marks the token consumed atomically before insert). Revocation sets revoked_at.
CREATE TABLE IF NOT EXISTS jit_grants (
  grant_id    text PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES jit_requests (id),
  token_hash  text NOT NULL REFERENCES jit_tokens (token_hash),
  site_id     text NOT NULL,
  requester   text,
  ttl_seconds integer NOT NULL,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  redeemed_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS jit_grants_site_idx ON jit_grants (site_id, status);
