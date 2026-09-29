import type { Pool } from 'pg';
import type { Queryable } from '../auth/audit.js';
import type { Scheduler } from '../scheduler/scheduler.js';

/**
 * A scan failed for a site: alert the site's team member and the org admins on Telegram, and register a task for the
 * team member. Everything is written to the durable outboxes (notification_outbox, task_outbox) - pass the SAME
 * transaction that records the scan, so the alert and the failed scan commit together and neither can be lost.
 * Delivery (Telegram send, task-portal call) happens later from those outboxes with retries.
 */
export interface ScanFailure {
  projectId: string;
  scanId: string;
  tool: string;
  /** 'failed' = the tool failed; 'partial' = it finished incompletely. */
  status: 'failed' | 'partial';
  reason?: string | null;
  runId?: string | null;
}

export interface RaisedAlert {
  siteId: string;
  siteName: string;
  /** notification_outbox rows created now (enqueue these after commit). */
  notificationIds: string[];
  taskId: string | null;
}

interface SiteRow {
  id: string;
  name: string;
  url: string | null;
  org_id: string;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  owner_chat: string | null;
}

export const telegramBotId = (): string => process.env.TELEGRAM_BOT_ID ?? 'platform';

/** Chat ids of the org's admins (org-level manager / security_admin) who have set a Telegram chat id. */
export async function adminChatIds(db: Queryable, orgId: string): Promise<string[]> {
  const r = await (db as Pool).query<{ telegram_chat_id: string }>(
    `SELECT DISTINCT u.telegram_chat_id
       FROM api_users u JOIN api_role_bindings b ON b.user_id = u.id
      WHERE b.org_id = $1 AND b.project_id IS NULL AND b.environment_id IS NULL
        AND b.role IN ('manager', 'security_admin')
        AND u.is_active AND u.telegram_chat_id IS NOT NULL`,
    [orgId]
  );
  return r.rows.map((x) => x.telegram_chat_id);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function scanFailureMessage(site: { name: string; url: string | null }, owner: string | null, f: ScanFailure): string {
  return [
    `🚨 Scan ${f.status === 'partial' ? 'incomplete' : 'failed'}: ${site.name}`,
    site.url ? site.url : null,
    `Tool: ${f.tool} · scan ${f.scanId}`,
    f.reason ? `Reason: ${clip(f.reason.replace(/\s+/g, ' ').trim(), 300)}` : null,
    owner ? `Handled by: ${owner} (task registered)` : 'No team member is assigned to this site yet.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Returns null when the project is not a registered (active) site - nothing to alert. */
export async function raiseScanFailure(db: Queryable, f: ScanFailure): Promise<RaisedAlert | null> {
  const pool = db as Pool;
  const s = (
    await pool.query<SiteRow>(
      `SELECT s.id::text, s.name, s.url, s.org_id::text,
              u.id::text AS owner_id, u.display_name AS owner_name, u.email AS owner_email, u.telegram_chat_id AS owner_chat
         FROM api_sites s LEFT JOIN api_users u ON u.id = s.owner_user_id AND u.is_active
        WHERE s.project_id = $1 AND s.status = 'active'`,
      [f.projectId]
    )
  ).rows[0];
  if (!s) return null;

  const dedupe = `scan.failed:${f.projectId}:${f.scanId}`;
  const body = scanFailureMessage(s, s.owner_name, f);
  const chats = [...new Set([...(s.owner_chat ? [s.owner_chat] : []), ...(await adminChatIds(db, s.org_id))])];

  const notificationIds: string[] = [];
  for (const chat of chats) {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO notification_outbox (event_type, bot_id, chat_id, body, dedupe_key)
       VALUES ('scan.failed', $1, $2, $3, $4)
       ON CONFLICT (channel, bot_id, chat_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id::text`,
      [telegramBotId(), chat, body, dedupe]
    );
    if (ins.rows[0]) notificationIds.push(ins.rows[0].id);
  }

  const task = await pool.query<{ id: string }>(
    `INSERT INTO task_outbox (site_id, assignee_user_id, kind, title, description, payload, dedupe_key)
     VALUES ($1, $2, 'scan.failed', $3, $4, $5::jsonb, $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id::text`,
    [
      s.id,
      s.owner_id,
      `Scan ${f.status === 'partial' ? 'incomplete' : 'failed'} on ${s.name} (${f.tool})`,
      body,
      JSON.stringify({ scanId: f.scanId, runId: f.runId ?? null, tool: f.tool, status: f.status, reason: f.reason ?? null, projectId: f.projectId }),
      dedupe,
    ]
  );

  return { siteId: s.id, siteName: s.name, notificationIds, taskId: task.rows[0]?.id ?? null };
}

/** After the transaction commits: hand the new outbox rows to the workers. Failures are safe: the reconciler re-enqueues. */
export async function dispatchAlert(scheduler: Scheduler | undefined, alert: RaisedAlert): Promise<void> {
  if (!scheduler || !scheduler.hasClass('notifications')) return;
  for (const outboxId of alert.notificationIds) {
    try {
      await scheduler.enqueue('notifications', { kind: 'notification', outboxId });
    } catch {
      // class disabled: rows stay pending; nothing is lost
    }
  }
}
