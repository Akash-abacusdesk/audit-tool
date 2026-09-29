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
    // Client-side (a server-side statement_timeout startup parameter is rejected by PgBouncer): a hung query
    // must not pin a pooled connection forever.
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? 60_000),
  });
}

/** Adapt a pg client/pool to pg-boss's `db` option, so `boss.send(..., { db })` joins the caller's transaction. */
export function asBossDb(db: Pick<Pool, 'query'>): { executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }> } {
  return { executeSql: async (text, values) => ({ rows: (await db.query(text, values)).rows }) };
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
