import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';

const RETENTION_QUEUE = 'ops.webhook.retention';

/**
 * S3-D2 retention ruling (god): raw webhook JSONB kept, pruned daily by one
 * pg-boss job at WEBHOOK_RETENTION_DAYS (default 30). Runs inside the API
 * process until a dedicated worker service exists; schedule() upserts, so
 * reboots don't stack duplicates.
 */
export async function startWebhookRetention(boss: PgBoss, pool: Pool): Promise<void> {
  const days = Number(process.env.WEBHOOK_RETENTION_DAYS ?? 30);
  const cron = process.env.WEBHOOK_RETENTION_CRON ?? '0 3 * * *';

  try {
    await boss.createQueue(RETENTION_QUEUE);
  } catch {
    // already exists
  }
  try {
    await boss.schedule(RETENTION_QUEUE, cron);
  } catch {
    // already scheduled
  }
  await boss.work(RETENTION_QUEUE, async () => {
    const window = (d: number) => String(d);
    await prune(pool, 'webhook events', 'api_webhook_events', `received_at < now() - ($1 || ' days')::interval`, window(days));
    // Bounded-growth tables that had no purge at all. api_audit_events is deliberately absent: the app role
    // has no DELETE on it (append-only) - retire old audit rows by partition/owner job instead.
    const sessionDays = window(Number(process.env.SESSION_RETENTION_DAYS ?? 7));
    await prune(pool, 'dead sessions', 'api_sessions',
      `LEAST(expires_at, COALESCE(revoked_at, expires_at)) < now() - ($1 || ' days')::interval`, sessionDays);
    await prune(pool, 'idempotency keys', 'api_idempotency_keys',
      `created_at < now() - ($1 || ' days')::interval`, window(Number(process.env.IDEMPOTENCY_RETENTION_DAYS ?? 7)));
    await prune(pool, 'sent notifications', 'notification_outbox',
      `status = 'sent' AND created_at < now() - ($1 || ' days')::interval`, window(Number(process.env.OUTBOX_RETENTION_DAYS ?? 30)));
  });
}

/** Delete in small batches so a large backlog never holds one long lock or bloats WAL in a single statement. */
async function prune(pool: Pool, label: string, table: string, cond: string, param: string): Promise<void> {
  const BATCH = 5000;
  let total = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${cond} LIMIT ${BATCH})`,
      [param]
    );
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < BATCH) break;
  }
  if (total > 0) console.log(`[retention] pruned ${total} ${label}`);
}
