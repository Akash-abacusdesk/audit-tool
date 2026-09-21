import { Pool, type PoolClient } from 'pg';

export function createPool(databaseUrl: string): Pool {
  // Connects through PgBouncer in transaction-pooling mode — keep pool small,
  // transactions short (docs/db-conventions.md).
  // Fail fast on acquire stalls (S1 gate intel: readyz hung 60s instead of 503).
  // PG_POOL_MAX: capacity-agnostic tuning knob — bouncer connection budget is
  // shared with pg-boss's own clients; shrink this if the budget tips over.
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    connectionTimeoutMillis: Number(process.env.PG_POOL_TIMEOUT_MS ?? 5000),
  });
}

/** Run `fn` inside one connection + transaction; rollback on throw. */
export async function withTx<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection already broken — nothing to roll back
    }
    throw err;
  } finally {
    client.release();
  }
}
