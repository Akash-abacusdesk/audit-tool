import type { Pool } from 'pg';

/**
 * Failure counter shared by every API replica (Postgres, per-minute buckets in an UNLOGGED table).
 *
 * The in-process limiter (rate-limit.ts) gives an attacker N times the limit across N replicas. Security-relevant
 * throttles - failed logins, step-up/MFA attempts - use this one instead. It costs one small indexed query per check,
 * paid only on those rare endpoints (never on the hot read path). Fails closed: if the DB is down the caller errors.
 */
export function createSharedLimiter(pool: Pick<Pool, 'query'>, max: number, windowMs: number) {
  const minutes = Math.max(1, Math.ceil(windowMs / 60_000));
  return {
    /** True when `key` already has >= max recorded failures inside the window. */
    async blocked(key: string): Promise<boolean> {
      const r = await pool.query<{ n: number | null }>(
        `SELECT COALESCE(SUM(count), 0)::int AS n FROM api_rate_limits
          WHERE key = $1 AND window_start > now() - make_interval(mins => $2)`,
        [key, minutes]
      );
      return (r.rows[0]?.n ?? 0) >= max;
    },
    /** Count one failure against `key`. */
    async record(key: string): Promise<void> {
      await pool.query(
        `INSERT INTO api_rate_limits (key, window_start, count) VALUES ($1, date_trunc('minute', now()), 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = api_rate_limits.count + 1`,
        [key]
      );
    },
  };
}
