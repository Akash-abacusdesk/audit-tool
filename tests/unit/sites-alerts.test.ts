import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { raiseScanFailure, scanFailureMessage } from '../../apps/api/src/sites/alerts.js';
import { backoffMinutes, deliverDueTasks, HttpTaskPortalClient, taskPortalFromEnv } from '../../apps/api/src/tasks/portal.js';

const SITE = { id: 's1', name: 'Acme Shop', url: 'https://shop.example.com', org_id: 'o1', owner_id: 'u1', owner_name: 'Dana', owner_email: 'dana@x.io', owner_chat: '111' };

/** Fake pool answering the queries raiseScanFailure makes; records every insert. */
function fakePool(opts: { site?: typeof SITE | null; admins?: string[]; existing?: Set<string> } = {}) {
  const site = opts.site === undefined ? SITE : opts.site;
  const seen = opts.existing ?? new Set<string>();
  const inserts: { table: string; params: unknown[] }[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM api_sites s')) return { rows: site ? [site] : [] };
      if (sql.includes('FROM api_users u JOIN api_role_bindings')) return { rows: (opts.admins ?? []).map((c) => ({ telegram_chat_id: c })) };
      if (sql.includes('INSERT INTO notification_outbox')) {
        const key = `n:${params[1]}:${params[3]}`;
        if (seen.has(key)) return { rows: [] };
        seen.add(key);
        inserts.push({ table: 'notification', params });
        return { rows: [{ id: `n-${inserts.length}` }] };
      }
      if (sql.includes('INSERT INTO task_outbox')) {
        const key = `t:${params[5]}`;
        if (seen.has(key)) return { rows: [] };
        seen.add(key);
        inserts.push({ table: 'task', params });
        return { rows: [{ id: 't-1' }] };
      }
      return { rows: [] };
    }),
  } as unknown as Pool;
  return { pool, inserts };
}

const failure = { projectId: 'p1', scanId: 'scan-9', tool: 'semgrep', status: 'failed' as const, reason: 'container exited 137' };

describe('raiseScanFailure', () => {
  it('alerts the owner and each admin once, and registers one task for the owner', async () => {
    const { pool, inserts } = fakePool({ admins: ['900', '111'] }); // 111 is also the owner's chat: must not double-send
    const r = await raiseScanFailure(pool, failure);
    expect(r?.siteName).toBe('Acme Shop');
    expect(inserts.filter((i) => i.table === 'notification').map((i) => i.params[1]).sort()).toEqual(['111', '900']);
    const task = inserts.find((i) => i.table === 'task')!;
    expect(task.params[1]).toBe('u1'); // assigned to the site's owner
    expect(String(task.params[3])).toContain('container exited 137');
    expect(r?.taskId).toBe('t-1');
  });

  it('is idempotent: re-ingesting the same failed scan creates no new alerts or task', async () => {
    const shared = new Set<string>();
    const first = fakePool({ admins: ['900'], existing: shared });
    await raiseScanFailure(first.pool, failure);
    const again = fakePool({ admins: ['900'], existing: shared });
    const r = await raiseScanFailure(again.pool, failure);
    expect(r?.notificationIds).toEqual([]);
    expect(r?.taskId).toBeNull();
  });

  it('does nothing for a project that is not a registered site', async () => {
    const { pool, inserts } = fakePool({ site: null });
    expect(await raiseScanFailure(pool, failure)).toBeNull();
    expect(inserts).toEqual([]);
  });

  it('still registers the task (unassigned) and alerts admins when the site has no owner', async () => {
    const { pool, inserts } = fakePool({ site: { ...SITE, owner_id: null as never, owner_name: null as never, owner_email: null as never, owner_chat: null as never }, admins: ['900'] });
    await raiseScanFailure(pool, failure);
    expect(inserts.find((i) => i.table === 'task')!.params[1]).toBeNull();
    expect(String(inserts.find((i) => i.table === 'notification')!.params[2])).toContain('No team member is assigned');
  });
});

describe('scanFailureMessage', () => {
  it('names the site, tool, scan and reason; distinguishes incomplete scans', () => {
    const m = scanFailureMessage({ name: 'Acme Shop', url: null }, 'Dana', { ...failure, status: 'partial', reason: 'timed out\nafter 60s' });
    expect(m).toContain('Scan incomplete: Acme Shop');
    expect(m).toContain('semgrep');
    expect(m).toContain('scan-9');
    expect(m).toContain('timed out after 60s'); // newlines collapsed
    expect(m).toContain('Dana');
  });
});

describe('task portal', () => {
  const task = { externalRef: 'scan.failed:p1:scan-9', kind: 'scan.failed', title: 'T', description: 'D', assignee: { email: 'dana@x.io', name: 'Dana', telegramChatId: '111' }, site: { id: 's1', name: 'Acme', url: null }, payload: { a: 1 } };

  it('POSTs the task with auth and an idempotency key, and returns the portal id', async () => {
    const f = vi.fn(async () => Response.json({ id: 42 }, { status: 201 }));
    const c = new HttpTaskPortalClient({ baseUrl: 'https://portal.example/', apiToken: 'tok', fetchImpl: f as never });
    expect(await c.createTask(task)).toEqual({ externalId: '42' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://portal.example/tasks');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(h['idempotency-key']).toBe('scan.failed:p1:scan-9');
    expect(JSON.parse(String(init.body)).assignee.email).toBe('dana@x.io');
  });

  it('rejects a non-2xx or an id-less response', async () => {
    const bad = new HttpTaskPortalClient({ baseUrl: 'https://p', apiToken: 't', fetchImpl: (async () => new Response('no', { status: 500 })) as never });
    await expect(bad.createTask(task)).rejects.toThrow(/500/);
    const noId = new HttpTaskPortalClient({ baseUrl: 'https://p', apiToken: 't', fetchImpl: (async () => Response.json({})) as never });
    await expect(noId.createTask(task)).rejects.toThrow(/no task id/);
  });

  it('is only configured when both env vars are present', () => {
    expect(taskPortalFromEnv({} as never)).toBeNull();
    expect(taskPortalFromEnv({ TASKPORTAL_BASE_URL: 'https://p' } as never)).toBeNull();
    expect(taskPortalFromEnv({ TASKPORTAL_BASE_URL: 'https://p', TASKPORTAL_API_TOKEN: 't' } as never)).not.toBeNull();
  });

  it('backs off exponentially, capped at an hour', () => {
    expect([1, 2, 3, 6, 10].map(backoffMinutes)).toEqual([2, 4, 8, 60, 60]);
  });

  describe('deliverDueTasks', () => {
    const leased = (attempts = 0) => ({ id: 'k1', kind: 'scan.failed', title: 'T', description: 'D', payload: {}, dedupe_key: 'dk', attempts, site_id: 's1', site_name: 'Acme', site_url: null, a_email: 'dana@x.io', a_name: 'Dana', a_chat: '111' });
    const poolWith = (rows: unknown[]) => {
      const updates: { sql: string; params: unknown[] }[] = [];
      const pool = { query: vi.fn(async (sql: string, params: unknown[] = []) => (sql.includes('WITH due') ? { rows } : (updates.push({ sql, params }), { rows: [] }))) } as unknown as Pool;
      return { pool, updates };
    };

    it('does nothing without a configured portal (tasks stay pending)', async () => {
      const { pool } = poolWith([leased()]);
      expect(await deliverDueTasks(pool, null)).toEqual({ attempted: 0, sent: 0, failed: 0 });
      expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('marks a delivered task sent with the portal id', async () => {
      const { pool, updates } = poolWith([leased()]);
      const r = await deliverDueTasks(pool, { createTask: async () => ({ externalId: 'X-1' }) });
      expect(r.sent).toBe(1);
      expect(updates[0]!.sql).toContain("status = 'sent'");
      expect(updates[0]!.params).toEqual(['k1', 'X-1']);
    });

    it('retries a failing task later, and gives up (failed) after the last attempt', async () => {
      const boom = { createTask: async () => { throw new Error('portal down'); } };
      const retry = poolWith([leased(0)]);
      await deliverDueTasks(retry.pool, boom);
      expect(retry.updates[0]!.params.slice(0, 5)).toEqual(['k1', 1, 'portal down', 'pending', 2]);
      const dead = poolWith([leased(7)]);
      const r = await deliverDueTasks(dead.pool, boom);
      expect(r.failed).toBe(1);
      expect(dead.updates[0]!.params[3]).toBe('failed');
    });
  });
});
