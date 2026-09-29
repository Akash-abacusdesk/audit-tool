-- 019_rate_limits.sql : failure counters shared across API replicas (see util/rate-limit-pg.ts).
-- UNLOGGED: counters are disposable (a crash only forgets recent failures), and skipping WAL keeps the writes cheap.
CREATE UNLOGGED TABLE IF NOT EXISTS api_rate_limits (
    key          text NOT NULL,
    window_start timestamptz NOT NULL,
    count        integer NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS api_rate_limits_window_idx ON api_rate_limits (window_start);
