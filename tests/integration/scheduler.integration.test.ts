/**
 * S4A scheduler PG integration tests — real compose stack (PG + PgBouncer +
 * pg-boss + API with the S4A Scheduler started). Orchestrated by
 * scripts/integration.mjs; runs AFTER auth.integration.test.ts (alphabetical,
 * --no-file-parallelism). Does NOT truncate: seeds its own org/user via the
 * direct :5433 connection, so ordering stays irrelevant.
 *
 * Covers: telemetry surface, enqueue→complete roundtrip, retry proof,
 * cancel proof, RBAC denials on the scheduler plane, disabled-class refusal.
 * Admission degraded-exclusion + restart-survival live in the runner phases
 * (they need process-level control of the API child).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { hashPassword } from '../../apps/api/src/auth/passwords.js';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3100';
const DB_URL = process.env.INTEGRATION_DB_URL;
if (!DB_URL) throw new Error('INTEGRATION_DB_URL (direct postgres://…:5433/…) is required');
const PROBE_TOKEN = process.env.SCHED_RESTART_PROBE_TOKEN ?? '';
if (!PROBE_TOKEN) throw new Error('SCHED_RESTART_PROBE_TOKEN is required (set by integration.mjs)');

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
interface JobStatusDto {
  id: string;
  state: JobState;
  retryCount: number;
}

async function api(
  path: string,
  init?: RequestInit & { token?: string }
): Promise<{ status: number; body: Envelope<unknown> }> {
  const headers: Record<string, string> = {};
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  if (init?.body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as Envelope<unknown> };
}

async function probe(
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: Envelope<{ jobId?: string; job?: JobStatusDto | null }> }> {
  // schedulerRoutes mounts under /api/v1 — internal probe inherits the prefix.
  const headers: Record<string, string> = {};
  if (init?.body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1/internal/scheduler/probe${path}`, {
    ...init,
    headers: { ...headers, authorization: `Bearer ${PROBE_TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as Envelope<{ job: JobStatusDto | null }> };
}

function probePost(classKey: string, payload: object): ReturnType<typeof probe> {
  return probe('', {
    method: 'POST',
    body: JSON.stringify({ classKey, ...payload }),
  });
}

async function pollJob(
  classKey: string,
  jobId: string,
  until: (s: JobStatusDto | null) => boolean,
  timeoutMs: number
): Promise<JobStatusDto | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await probe(`/${classKey}/${jobId}`);
    expect(r.status).toBe(200);
    const job = r.body.data!.job;
    if (until(job)) return job;
    if (Date.now() > deadline) return job;
    await new Promise((res) => setTimeout(res, 250));
  }
}

const SCH_ADMIN = { email: 'sched@it.test', password: 'sched-pass-123456', displayName: 'Sched Admin' };
const SCH_NOBODY = { email: 'sched-nobody@it.test', password: 'nobody-pass-123456', displayName: 'No Body' };

let token: string;
let noPermToken: string;

beforeAll(async () => {
  // Seed directly over :5433 — independent of auth-suite fixture state/order.
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  const org = await c.query<{ id: string }>(
    `INSERT INTO api_orgs (name, slug) VALUES ('Sched Org', $1)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id::text`,
    [`sched-org-${process.pid}`]
  );
  const hash = await hashPassword(SCH_ADMIN.password);
  await c.query(
    `INSERT INTO api_users (email, display_name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [SCH_ADMIN.email, SCH_ADMIN.displayName, hash]
  );
  const admin = await c.query<{ id: string }>('SELECT id::text FROM api_users WHERE email = $1', [
    SCH_ADMIN.email,
  ]);
  await c.query(
    `INSERT INTO api_role_bindings (user_id, role, org_id) VALUES ($1, 'manager', $2)
     ON CONFLICT DO NOTHING`,
    [admin.rows[0]!.id, org.rows[0]!.id]
  );
  const nobodyHash = await hashPassword(SCH_NOBODY.password);
  await c.query(
    `INSERT INTO api_users (email, display_name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [SCH_NOBODY.email, SCH_NOBODY.displayName, nobodyHash]
  );
  await c.end();

  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: SCH_ADMIN.email, password: SCH_ADMIN.password }),
  });
  expect(login.status).toBe(200);
  token = (login.body.data as { token: string }).token;

  // S4VAL-1: scheduler plane sits on the admin gate — fresh step-up required
  // before any privileged scheduler call in this suite.
  const stepUp = await api('/auth/step-up', {
    method: 'POST',
    token,
    body: JSON.stringify({ password: SCH_ADMIN.password }),
  });
  expect(stepUp.status).toBe(200);

  const login2 = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: SCH_NOBODY.email, password: SCH_NOBODY.password }),
  });
  expect(login2.status).toBe(200);
  noPermToken = (login2.body.data as { token: string }).token;
});

describe('S4A scheduler against real PG + pg-boss', () => {
  it('scheduler plane is default-deny: anonymous 401, role-less 403', async () => {
    const anon = await api('/scheduler/stats');
    expect(anon.status).toBe(401);
    const noPerm = await api('/scheduler/stats', { token: noPermToken });
    expect(noPerm.status).toBe(403);
    expect(noPerm.body.error!.code).toBe('FORBIDDEN');
  });

  it('telemetry exposes every class, verdict and admission state', async () => {
    const r = await api('/scheduler/stats', { token });
    expect(r.status).toBe(200);
    const data = r.body.data as {
      verdict: string;
      classes: {
        key: string;
        queue: string;
        disabled: boolean;
        heavy: boolean;
        admittingWorkers: boolean;
      }[];
    };
    expect(['ok', 'degraded', 'blocked']).toContain(data.verdict);
    expect(data.classes).toHaveLength(12); // 11 original + notifications (S9 outbox)
    expect(data.classes.some((c) => c.key === 'notifications')).toBe(true);
    const ai = data.classes.find((c) => c.key === 'ai_remediation')!;
    expect(ai.disabled).toBe(true);
    expect(ai.admittingWorkers).toBe(false);
    expect(data.classes.find((c) => c.key === 'critical_interactive')!.admittingWorkers).toBe(true);
  });

  it('enqueue → worker consumes → completed roundtrip', { timeout: 30_000 }, async () => {
    const enq = await probePost('standard_pr', { demoMs: 50 });
    expect(enq.status).toBe(201);
    const jobId = enq.body.data!.jobId!;
    const done = await pollJob('standard_pr', jobId, (j) => j?.state === 'completed', 15_000);
    expect(done?.state).toBe('completed');
    expect(done?.retryCount).toBe(0);
  });

  it('failing job retries then completes (retryCount proves it)', { timeout: 30_000 }, async () => {
    const enq = await probePost('network_light', { failAttempts: 1, demoMs: 0 });
    expect(enq.status).toBe(201);
    const jobId = enq.body.data!.jobId!;
    const done = await pollJob('network_light', jobId, (j) => j?.state === 'completed', 20_000);
    expect(done?.state).toBe('completed');
    expect((done?.retryCount ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('cancel stops a running job (state → cancelled)', { timeout: 30_000 }, async () => {
    const enq = await probePost('cpu_heavy', { demoMs: 20_000 });
    expect(enq.status).toBe(201);
    const jobId = enq.body.data!.jobId!;
    await pollJob('cpu_heavy', jobId, (j) => j?.state === 'active', 10_000);
    const cancel = await api('/scheduler/jobs/cancel', {
      method: 'POST',
      token,
      body: JSON.stringify({ classKey: 'cpu_heavy', jobId }),
    });
    expect(cancel.status).toBe(200);
    const after = await pollJob('cpu_heavy', jobId, (j) => j?.state === 'cancelled', 5_000);
    expect(after?.state).toBe('cancelled');
  });

  it('disabled class refuses jobs; unknown class 404s', async () => {
    const ai = await probePost('ai_remediation', {});
    expect(ai.status).toBe(404);
    const unknownEnq = await api('/scheduler/jobs', {
      method: 'POST',
      token,
      body: JSON.stringify({ classKey: 'nope_heavy' }),
    });
    expect(unknownEnq.status).toBe(404);
    const unknownCancel = await api('/scheduler/jobs/cancel', {
      method: 'POST',
      token,
      body: JSON.stringify({ classKey: 'nope_heavy', jobId: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(unknownCancel.status).toBe(404);
  });

  it(
    'scan-shaped job executes through the worker runtime; docker-level failure surfaces as failed job',
    { timeout: 60_000 },
    async () => {
      // Invalid image ref fails inside the runtime (pre-flight/docker), never
      // pulls anything. SCHED_IO_HEAVY_RETRY_LIMIT=0 (runner) makes it terminal.
      const outDir = mkdtempSync(path.join(tmpdir(), 's4a-scan-out-'));
      const enq = await probePost('io_heavy', {
        kind: 'scan',
        tool: 'gitleaks',
        image: 'invalid-image-ref::##',
        outDir,
        egressMode: 'offline',
      });
      expect(enq.status).toBe(201);
      const jobId = enq.body.data!.jobId!;
      const done = await pollJob(
        'io_heavy',
        jobId,
        (j) => j?.state === 'failed' || j?.state === 'completed',
        45_000
      );
      expect(done?.state).toBe('failed');
      // run registry cleaned up after terminal state
      const stats = await api('/scheduler/stats', { token });
      expect((stats.body.data as { activeRuns: string[] }).activeRuns).toEqual([]);
    }
  );
});
