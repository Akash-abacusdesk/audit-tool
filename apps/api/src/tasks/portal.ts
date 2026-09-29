import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { withRetry } from '@platform/shared';

/**
 * Task-portal integration. The portal's API is not final yet, so this is the seam: the rest of the platform only ever
 * writes rows to task_outbox; this module turns due rows into portal tasks once a portal is configured
 * (TASKPORTAL_BASE_URL + TASKPORTAL_API_TOKEN). Until then rows simply stay `pending` and show up in the admin UI.
 *
 * ASSUMED CONTRACT (adjust HttpTaskPortalClient when the real API is known - nothing else needs to change):
 *   POST {base}/tasks   Authorization: Bearer <token>   Idempotency-Key: <externalRef>
 *   body  { title, description, kind, externalRef, assignee: { email, name, telegramChatId } | null,
 *           site: { id, name, url } | null, payload: {...} }
 *   200/201 -> { id: string | number }
 */
export interface PortalTask {
  externalRef: string;
  kind: string;
  title: string;
  description: string;
  assignee: { email: string; name: string; telegramChatId: string | null } | null;
  site: { id: string; name: string; url: string | null } | null;
  payload: unknown;
}

export interface TaskPortalClient {
  createTask(task: PortalTask): Promise<{ externalId: string }>;
}

export interface HttpTaskPortalConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpTaskPortalClient implements TaskPortalClient {
  constructor(private readonly cfg: HttpTaskPortalConfig) {}

  async createTask(task: PortalTask): Promise<{ externalId: string }> {
    const f = withRetry(this.cfg.fetchImpl ?? fetch);
    const res = await f(`${this.cfg.baseUrl.replace(/\/$/, '')}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiToken}`,
        'idempotency-key': task.externalRef, // a retried delivery must not create a second task
      },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`task portal responded ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { id?: string | number; data?: { id?: string | number } };
    const id = body.id ?? body.data?.id;
    if (id === undefined || id === null) throw new Error('task portal response had no task id');
    return { externalId: String(id) };
  }
}

export function taskPortalFromEnv(env: NodeJS.ProcessEnv = process.env): TaskPortalClient | null {
  return env.TASKPORTAL_BASE_URL && env.TASKPORTAL_API_TOKEN
    ? new HttpTaskPortalClient({ baseUrl: env.TASKPORTAL_BASE_URL, apiToken: env.TASKPORTAL_API_TOKEN })
    : null;
}

const MAX_ATTEMPTS = Number(process.env.TASKPORTAL_MAX_ATTEMPTS ?? 8);
/** Minutes to wait before the next attempt: 2, 4, 8 ... capped at an hour. */
export const backoffMinutes = (attempts: number): number => Math.min(60, 2 ** attempts);

interface LeasedRow {
  id: string;
  kind: string;
  title: string;
  description: string;
  payload: unknown;
  dedupe_key: string | null;
  attempts: number;
  site_id: string | null;
  site_name: string | null;
  site_url: string | null;
  a_email: string | null;
  a_name: string | null;
  a_chat: string | null;
}

/**
 * Deliver due `pending` tasks. Rows are leased (next_attempt_at pushed out) before the network call, so concurrent
 * replicas never double-send and a crash mid-call just makes the row due again later. No client = no-op.
 */
export async function deliverDueTasks(
  pool: Pool,
  client: TaskPortalClient | null,
  opts: { limit?: number; log?: (m: string) => void } = {}
): Promise<{ attempted: number; sent: number; failed: number }> {
  const out = { attempted: 0, sent: 0, failed: 0 };
  if (!client) return out;
  const leased = await pool.query<LeasedRow>(
    `WITH due AS (
       SELECT id FROM task_outbox WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
     ), l AS (
       UPDATE task_outbox t SET next_attempt_at = now() + interval '2 minutes'
         FROM due WHERE t.id = due.id
       RETURNING t.*
     )
     SELECT l.id::text, l.kind, l.title, l.description, l.payload, l.dedupe_key, l.attempts,
            l.site_id::text, s.name AS site_name, s.url AS site_url,
            u.email AS a_email, u.display_name AS a_name, u.telegram_chat_id AS a_chat
       FROM l LEFT JOIN api_sites s ON s.id = l.site_id LEFT JOIN api_users u ON u.id = l.assignee_user_id`,
    [opts.limit ?? 20]
  );
  for (const r of leased.rows) {
    out.attempted++;
    try {
      const { externalId } = await client.createTask({
        externalRef: r.dedupe_key ?? r.id,
        kind: r.kind,
        title: r.title,
        description: r.description,
        assignee: r.a_email ? { email: r.a_email, name: r.a_name ?? r.a_email, telegramChatId: r.a_chat } : null,
        site: r.site_id ? { id: r.site_id, name: r.site_name ?? '', url: r.site_url } : null,
        payload: r.payload,
      });
      await pool.query(
        `UPDATE task_outbox SET status = 'sent', external_id = $2, sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`,
        [r.id, externalId]
      );
      out.sent++;
    } catch (err) {
      const attempts = r.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await pool.query(
        `UPDATE task_outbox SET attempts = $2, last_error = $3, status = $4,
                next_attempt_at = now() + make_interval(mins => $5) WHERE id = $1`,
        [r.id, attempts, String((err as Error).message).slice(0, 500), dead ? 'failed' : 'pending', backoffMinutes(attempts)]
      );
      if (dead) out.failed++;
      opts.log?.(`task ${r.id} delivery failed (attempt ${attempts}): ${(err as Error).message}`);
    }
  }
  return out;
}

const QUEUE = 'ops.tasks.deliver';

/** Set by startTaskDelivery; callers kick it after committing a new task so it goes out in seconds, not at the next tick. */
export const taskDelivery: { kick: () => Promise<void> } = { kick: async () => {} };

/** Delivery worker: a job per new task (fast path) plus a per-minute sweep for retries and stragglers. */
export async function startTaskDelivery(boss: PgBoss, pool: Pool, client: TaskPortalClient | null): Promise<void> {
  try {
    await boss.createQueue(QUEUE);
  } catch {
    // already exists
  }
  try {
    await boss.schedule(QUEUE, '* * * * *');
  } catch {
    // already scheduled
  }
  await boss.work(QUEUE, { pollingIntervalSeconds: 5 }, async () => {
    await deliverDueTasks(pool, client, { log: (m) => console.warn(`[tasks] ${m}`) });
  });
  taskDelivery.kick = async () => {
    if (client) await boss.send(QUEUE, {}, { singletonKey: 'kick', singletonSeconds: 2 }).catch(() => {});
  };
}
