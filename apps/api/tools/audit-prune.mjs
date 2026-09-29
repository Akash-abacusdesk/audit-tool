#!/usr/bin/env node
/**
 * Retire old api_audit_events rows - ONLY ones already shipped off-host by audit-export.mjs.
 *
 * The runtime role has no DELETE on the audit table (infrastructure/db/audit-append-only.sql), so run this
 * with the table-OWNER connection string, from cron/ops, never from the API process.
 *
 * cutoff = min(now - AUDIT_RETENTION_DAYS, export watermark). No watermark (never exported) = refuse.
 *
 * Usage:  node tools/audit-prune.mjs [--dry-run]
 * Env:    DATABASE_URL (owner role), AUDIT_EXPORT_SPOOL_DIR (default ./audit-spool), AUDIT_RETENTION_DAYS (default 365)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const dry = process.argv.includes('--dry-run');
const days = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
const statePath = join(process.env.AUDIT_EXPORT_SPOOL_DIR ?? './audit-spool', 'state.json');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (table-owner role) is required');
if (!existsSync(statePath)) {
  console.error('refusing to prune: no export state.json - nothing has been shipped off-host yet');
  process.exit(2);
}
const { lastCreatedAt } = JSON.parse(readFileSync(statePath, 'utf8'));
if (!lastCreatedAt) {
  console.error('refusing to prune: export watermark is empty');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  // LEAST() in SQL so the watermark keeps PG's own timestamp text form (no JS Date round-trip loss).
  const cutoff = (await pool.query(`SELECT LEAST(now() - make_interval(days => $1), $2::timestamptz) AS c`, [days, lastCreatedAt])).rows[0].c;
  if (dry) {
    const n = (await pool.query('SELECT count(*)::int AS n FROM api_audit_events WHERE created_at < $1', [cutoff])).rows[0].n;
    console.log(JSON.stringify({ dryRun: true, cutoff, wouldDelete: n }));
  } else {
    let total = 0;
    for (;;) {
      const r = await pool.query(
        'DELETE FROM api_audit_events WHERE ctid IN (SELECT ctid FROM api_audit_events WHERE created_at < $1 LIMIT 5000)',
        [cutoff]
      );
      total += r.rowCount;
      if (r.rowCount < 5000) break;
    }
    console.log(JSON.stringify({ deleted: total, cutoff }));
  }
} finally {
  await pool.end();
}
