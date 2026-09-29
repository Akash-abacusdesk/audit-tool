/**
 * S9 outbound-alert call site: durable, deduped Telegram alerts on newly
 * discovered critical-severity findings. Reuses the same
 * telegram_authorizations allow-list S9's inbound callbacks use — a
 * (bot_id, chat_id) is eligible when it holds the 'finding.alert.critical'
 * action, scoped to the finding's project (or unscoped/global).
 *
 * Insert-then-enqueue, not send-inline: the outbox row is the durability
 * boundary (PRD §16 notification_outbox) — a crash between insert and
 * enqueue just leaves a 'pending' row a retry/backfill can pick up later;
 * nothing is lost, and nothing double-sends thanks to the dedupe_key unique
 * index (one row per finding fingerprint per chat).
 */
import type { Pool } from 'pg';
import type { Scheduler } from '../scheduler/scheduler.js';

export const CRITICAL_FINDING_ALERT_ACTION = 'finding.alert.critical' as const;

export interface CriticalFinding {
  id: string;
  projectId: string;
  title: string;
  ruleId: string | null;
  targetRef: string | null;
}

export async function enqueueCriticalFindingAlerts(
  pool: Pool,
  scheduler: Scheduler | undefined,
  finding: CriticalFinding
): Promise<void> {
  if (!scheduler || !scheduler.hasClass('notifications')) return;

  const subs = await pool.query<{ bot_id: string; chat_id: string }>(
    `SELECT DISTINCT bot_id, chat_id FROM telegram_authorizations
       WHERE $1 = ANY(actions) AND revoked_at IS NULL
         AND (project_id IS NULL OR project_id = $2::uuid)`,
    [CRITICAL_FINDING_ALERT_ACTION, finding.projectId]
  );
  if (subs.rows.length === 0) return;

  const body = [
    `🚨 Critical finding: ${finding.title}`,
    finding.ruleId ? `Rule: ${finding.ruleId}` : null,
    finding.targetRef ? `Target: ${finding.targetRef}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  for (const sub of subs.rows) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO notification_outbox (event_type, bot_id, chat_id, body, dedupe_key)
       VALUES ('finding.critical', $1, $2, $3, $4)
       ON CONFLICT (channel, bot_id, chat_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [sub.bot_id, sub.chat_id, body, finding.id]
    );
    const outboxId = inserted.rows[0]?.id;
    if (!outboxId) continue; // already alerted this chat for this finding
    try {
      await scheduler.enqueue('notifications', { kind: 'notification', outboxId });
    } catch {
      // class disabled (e.g. SCHED_NOTIFICATIONS_DISABLED=1) — row stays
      // 'pending' in the outbox; finding ingestion must not fail over this.
    }
  }
}
