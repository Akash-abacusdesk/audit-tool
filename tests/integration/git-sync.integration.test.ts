/**
 * S3-D1B PG integration: provider sync + synced snapshot reads against the
 * real stack. Provider is the canned GitHub stub booted by
 * scripts/integration.mjs (GIT_API_BASE_URL points the API child at it;
 * GIT_STUB_TOKEN is the bearer it accepts). Also exercises the
 * JOB.webhookReceived consumer end-to-end by inserting a pgboss job directly.
 *
 * Sequential-file model: this file truncates api_* tables in beforeAll — safe
 * because integration.mjs runs vitest with --no-file-parallelism (e841220).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import { JOB } from '../../packages/shared/src/jobs.js';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3100';
const DB_URL = process.env.INTEGRATION_DB_URL;
if (!DB_URL) throw new Error('INTEGRATION_DB_URL (direct postgres://…:5433/…) is required');
const STUB_TOKEN = process.env.GIT_STUB_TOKEN ?? 'stub-pat-token-1';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function call(
  path: string,
  init?: RequestInit & { token?: string }
): Promise<{ status: number; body: Envelope<unknown> }> {
  const headers: Record<string, string> = {};
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  if (init?.body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as Envelope<unknown> };
}

const ADMIN = {
  email: 'gitsync-root@it.test',
  password: 'bootstrap-pass-123',
  displayName: 'Git Sync Admin',
  orgName: 'Sync Org',
  orgSlug: 'sync-org',
};

let adminToken: string;
let orgId: string;
let projectId: string;
let connectionId: string;
let repoLinkId: string;

beforeAll(async () => {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query(
    `TRUNCATE api_sessions, api_role_bindings, api_audit_events,
            api_git_credentials,
            api_git_connections, api_webhook_events, api_repo_links,
            api_git_branches, api_git_commits, api_git_pull_requests,
            api_stack_detections, api_policy_assignments,
            api_environments, api_projects, api_orgs, api_users RESTART IDENTITY CASCADE`
  );
  // Data-level reset; org/user/project fixtures are created via API/SQL in
  // the first test below (same pattern as the S3-D1 suite).
  await c.end();
});

afterAll(async () => {});

describe('S3-D1B git sync against real PG + stubbed provider', () => {
  it('bootstrap + project fixture', async () => {
    const boot = await call('/auth/bootstrap', { method: 'POST', body: JSON.stringify(ADMIN) });
    expect(boot.status).toBe(201);
    adminToken = (boot.body.data as { token: string }).token;

    const me = await call('/auth/me', { token: adminToken });
    const m = me.body.data as { user: { id: string }; bindings: { orgId: string }[] };
    orgId = m.bindings[0]!.orgId;

    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    const proj = await c.query<{ id: string }>(
      `INSERT INTO api_projects (org_id, name, slug) VALUES ($1::uuid, 'Sync IT', 'sync-it') RETURNING id::text AS id`,
      [orgId]
    );
    projectId = proj.rows[0]!.id;
    await c.end();
  });

  it('connection + encrypted credential + repo link', async () => {
    const conn = await call('/git-connections', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ orgId, provider: 'github', displayName: 'IT Stub' }),
    });
    expect(conn.status).toBe(201);
    connectionId = (conn.body.data as { id: string }).id;

    const cred = await call(`/git-connections/${connectionId}/credential`, {
      method: 'PUT',
      token: adminToken,
      body: JSON.stringify({ token: STUB_TOKEN }),
    });
    expect(cred.status).toBe(200);

    // Ciphertext at rest must not contain the plaintext token.
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    const row = await c.query<{ ciphertext: string }>(
      'SELECT ciphertext FROM api_git_credentials WHERE connection_id = $1',
      [connectionId]
    );
    expect(row.rows[0]!.ciphertext).not.toContain(STUB_TOKEN);
    await c.end();

    const link = await call('/repo-links', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        projectId,
        connectionId,
        externalRepoId: '123',
        fullName: 'octo/hello',
        defaultBranch: 'main',
      }),
    });
    expect(link.status).toBe(201);
    repoLinkId = (link.body.data as { id: string }).id;
  });

  it('repo-links list over joined table (42702 keyset qualifier regression)', async () => {
    // Pre-fix ANY execution died at plan time: PG 42702 ambiguous created_at
    // (api_repo_links l JOIN api_git_connections c both have it).
    const list = await call(`/repo-links?projectId=${projectId}`, { token: adminToken });
    expect(list.status).toBe(200);
    const items = (list.body.data as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id)).toContain(repoLinkId);

    // Qualified keyset cursor predicate must bind too (not just ORDER BY),
    // and numeric-string limit must coerce (query params arrive as strings).
    const cur = Buffer.from(`${Date.now()}|${crypto.randomUUID()}`).toString('base64url');
    const filtered = await call(`/repo-links?projectId=${projectId}&cursor=${cur}&limit=1`, {
      token: adminToken,
    });
    expect(filtered.status).toBe(200);
  });

  it('manual sync returns counts and persists the snapshot', async () => {
    const t0 = Date.now();
    const sync = await call(`/repo-links/${repoLinkId}/sync`, { method: 'POST', token: adminToken });
    // 20s budget: a provider-side stall must surface as a real status, not a
    // vitest 5s kill (first battery's failures were ambiguous because of that).
    console.log(`[git-sync-it] POST sync -> ${sync.status} +${Date.now() - t0}ms`);
    expect(sync.status).toBe(200);
    expect(sync.body.data).toMatchObject({
      repoLinkId: repoLinkId,
      counts: { branches: 2, commits: 1, pullRequests: 2 },
    });
    expect(Date.now() - t0).toBeLessThan(15_000);

    const branches = await call(`/repo-links/${repoLinkId}/branches`, { token: adminToken });
    expect(branches.status).toBe(200);
    const b = branches.body.data as { name: string; headSha: string | null }[];
    expect(b.map((x) => x.name).sort()).toEqual(['feat/widget', 'main']);
    expect(b.find((x) => x.name === 'main')!.headSha).toBe('a'.repeat(40));

    const commits = await call(`/repo-links/${repoLinkId}/commits?branch=main`, { token: adminToken });
    const cm = commits.body.data as { sha: string; authorEmail: string | null; committedAt: string }[];
    expect(cm).toHaveLength(1);
    expect(cm[0]!.sha).toBe('c'.repeat(40));
    expect(cm[0]!.authorEmail).toBe('dev@example.com');

    const prs = await call(`/repo-links/${repoLinkId}/pull-requests`, { token: adminToken });
    const prList = prs.body.data as { externalId: string; state: string }[];
    expect(prList.map((p) => `${p.externalId}:${p.state}`).sort()).toEqual(['6:merged', '7:open']);
  }, 20_000);

  it('re-sync is idempotent (no duplicate rows)', async () => {
    const again = await call(`/repo-links/${repoLinkId}/sync`, { method: 'POST', token: adminToken });
    expect(again.status).toBe(200);
    const branches = await call(`/repo-links/${repoLinkId}/branches`, { token: adminToken });
    expect((branches.body.data as unknown[]).length).toBe(2);
    const prs = await call(`/repo-links/${repoLinkId}/pull-requests`, { token: adminToken });
    expect((prs.body.data as unknown[]).length).toBe(2);
  }, 20_000);

  it('authz: unauthenticated reads are 401; missing repo-link is 404', async () => {
    const unauth = await call(`/repo-links/${repoLinkId}/branches`);
    expect(unauth.status).toBe(401);
    const missing = await call('/repo-links/00000000-0000-0000-0000-000000000000/branches', {
      token: adminToken,
    });
    expect(missing.status).toBe(404);
  });

  it('webhook consumer: JOB.git.webhook.received re-syncs matching repo link', async () => {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    // Simulate pam's ingress output: verified delivery row + queue job.
    const ev = await c.query<{ id: string }>(
      `INSERT INTO api_webhook_events (connection_id, delivery_id, event_type, verified, payload)
       VALUES ($1::uuid, 'it-delivery-1', 'push', true, $2)
       RETURNING id::text AS id`,
      [connectionId, JSON.stringify({ repository: { full_name: 'octo/hello' } })]
    );
    const eventId = ev.rows[0]!.id;
    await c.query(`DELETE FROM api_git_branches WHERE repo_link_id = $1::uuid`, [repoLinkId]);
    await c.end();
    // Produce through a real pg-boss client (what pam's ingress will do) —
    // raw SQL inserts into pgboss.job miss v12 bookkeeping columns.
    const boss = new PgBoss({ connectionString: DB_URL, schema: 'pgboss' });
    await boss.start();
    const jobId = await boss.send(JOB.webhookReceived, { eventId });
    await boss.stop();
    expect(jobId).not.toBeNull();
    // Poll for processed_at (worker polls every ~2s).
    const poll = new Client({ connectionString: DB_URL });
    await poll.connect();
    let done = false;
    for (let i = 0; i < 30 && !done; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const chk = await poll.query<{ processed_at: Date | null }>(
        'SELECT processed_at FROM api_webhook_events WHERE id = $1',
        [eventId]
      );
      done = chk.rows[0]?.processed_at !== null;
    }
    const branches = await poll.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM api_git_branches WHERE repo_link_id = $1::uuid',
      [repoLinkId]
    );
    await poll.end();
    expect(done).toBe(true);
    expect(Number(branches.rows[0]!.n)).toBe(2); // restored by the consumer
  }, 45_000);
});
