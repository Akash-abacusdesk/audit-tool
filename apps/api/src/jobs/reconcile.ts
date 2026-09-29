import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Scheduler } from '../scheduler/scheduler.js';
import { JOB, stagingDestroyPayload, stagingProvisionPayload, updatePromotePayload, updateStagePayload } from '@platform/shared';

const QUEUE = 'ops.reconcile';

/**
 * Self-heal runs whose job was lost: the orchestrators advance state and THEN send the pg-boss job, so a crash in
 * between strands the run in an "in-flight" state that nothing will ever finish. Any run still in such a state
 * after RECONCILE_STUCK_MIN (default 65 - longer than a job's 30 min expiry plus retries) gets its job re-sent.
 * Workers are idempotent (provision/destroy clear leftovers first; wp-cli update is a no-op once applied), so an
 * unnecessary re-send is harmless.
 * ponytail: restore_point is not reconciled - it is also the state after a successful snapshot, so it can't
 * distinguish "job lost" from "done". A lost snapshot job just means no restore point; re-run snapshot manually.
 */
export async function startReconciler(boss: PgBoss, pool: Pool, scheduler?: Scheduler): Promise<void> {
  const stuckMin = Number(process.env.RECONCILE_STUCK_MIN ?? 65);
  try {
    await boss.createQueue(QUEUE);
  } catch {
    // already exists
  }
  try {
    await boss.schedule(QUEUE, process.env.RECONCILE_CRON ?? '*/10 * * * *');
  } catch {
    // already scheduled
  }
  await boss.work(QUEUE, { pollingIntervalSeconds: 30 }, async () => {
    const old = `updated_at < now() - make_interval(mins => $1)`;
    let resent = 0;

    const staging = await pool.query<{ id: string; project_id: string; environment_id: string; ref: string; state: string }>(
      `SELECT id::text, project_id::text, environment_id::text, ref, state FROM api_staging_runs
        WHERE state IN ('provisioning', 'destroying') AND ${old}`,
      [stuckMin]
    );
    for (const r of staging.rows) {
      const [queue, payload] =
        r.state === 'provisioning'
          ? [JOB.stagingProvision, stagingProvisionPayload.parse({ stagingId: r.id, projectId: r.project_id, environmentId: r.environment_id, ref: r.ref })]
          : [JOB.stagingDestroy, stagingDestroyPayload.parse({ stagingId: r.id })];
      await boss.send(queue, payload);
      await pool.query('UPDATE api_staging_runs SET updated_at = now() WHERE id = $1', [r.id]); // don't re-send every tick
      resent++;
    }

    const updates = await pool.query<{ id: string; state: string }>(
      `SELECT id::text, state FROM api_update_units WHERE state IN ('staging_validation', 'promoting') AND ${old}`,
      [stuckMin]
    );
    for (const r of updates.rows) {
      const [queue, payload] =
        r.state === 'staging_validation'
          ? [JOB.updateStage, updateStagePayload.parse({ updateUnitId: r.id })]
          : [JOB.updatePromote, updatePromotePayload.parse({ updateUnitId: r.id })];
      await boss.send(queue, payload);
      await pool.query('UPDATE api_update_units SET updated_at = now() WHERE id = $1', [r.id]);
      resent++;
    }
    // Outbox rows the ingest path inserted but never got enqueued (crash, or the class was disabled at the time).
    // runNotificationJob is idempotent per row (skips 'sent'), so a re-enqueue is safe.
    if (scheduler?.hasClass('notifications')) {
      const pending = await pool.query<{ id: string }>(
        `SELECT id::text FROM notification_outbox WHERE status = 'pending' AND created_at < now() - interval '10 minutes' LIMIT 200`
      );
      for (const r of pending.rows) {
        try {
          await scheduler.enqueue('notifications', { kind: 'notification', outboxId: r.id });
          resent++;
        } catch {
          break; // class disabled: leave the rows pending
        }
      }
    }
    if (resent > 0) console.log(`[reconcile] re-sent ${resent} lost job(s)`);
  });
}
