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
    const r = await pool.query(
      `DELETE FROM api_webhook_events WHERE received_at < now() - ($1 || ' days')::interval`,
      [String(days)]
    );
    if ((r.rowCount ?? 0) > 0) {
      console.log(`[retention] pruned ${r.rowCount} webhook events older than ${days}d`);
    }
  });
}
