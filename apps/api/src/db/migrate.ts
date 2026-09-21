import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Migration runner — strategy in docs/db-conventions.md §1.
 * Forward-only numbered .sql files; single transaction per run with a savepoint
 * per file; pg advisory lock so concurrent deploys serialize; refuses
 * out-of-order (gap) files instead of guessing.
 */
export async function migrate(pool: Pool, dir?: string): Promise<string[]> {
  const migrationsDir =
    dir ?? fileURLToPath(new URL('../../migrations/', import.meta.url));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // xact-scoped advisory lock: released automatically at COMMIT/ROLLBACK
    await client.query("SELECT pg_advisory_xact_lock(hashtext('platform:migrations'))");
    await client.query(
      'CREATE SCHEMA IF NOT EXISTS platform;' +
        'CREATE TABLE IF NOT EXISTS platform.schema_migrations (' +
        'name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );

    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM platform.schema_migrations'
    );
    const applied = new Set(rows.map((r) => r.name));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    const lastApplied = files.reduce<string | null>(
      (acc, f) => (applied.has(f) ? f : acc),
      null
    );
    const pending = files.filter((f) => !applied.has(f));
    if (lastApplied !== null) {
      const gap = pending.find((f) => f < lastApplied);
      if (gap !== undefined) {
        throw new Error(
          `out-of-order migration ${gap} sorts before already-applied ${lastApplied}; refusing`
        );
      }
    }

    const appliedNow: string[] = [];
    for (const file of pending) {
      await client.query('SAVEPOINT mig');
      try {
        await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
        await client.query(
          'INSERT INTO platform.schema_migrations (name) VALUES ($1)',
          [file]
        );
        await client.query('RELEASE SAVEPOINT mig');
        appliedNow.push(file);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT mig');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await client.query('COMMIT');
    return appliedNow;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection already broken
    }
    throw err;
  } finally {
    client.release();
  }
}
