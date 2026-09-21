/**
 * Environment smoke tests — S1-D6 / Section validation (build plan lines 163–169).
 * Preconditions, provided by scripts/smoke.mjs: full stack up from clean state —
 * PostgreSQL + PgBouncer + pg-boss + API on BASE_URL (default http://127.0.0.1:3000).
 * Asserts the shared envelope/error conventions are exercised by real endpoints.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
const EXAMPLES = `${BASE}/api/v1/examples`;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; requestId?: string };
}

async function call(
  path: string,
  init?: RequestInit & { idempotencyKey?: string }
): Promise<{ status: number; requestId: string | null; body: Envelope<unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(BASE + path, { ...init, headers });
  return {
    status: res.status,
    requestId: res.headers.get('x-request-id'),
    body: (await res.json()) as Envelope<unknown>,
  };
}

let createdId: string;

beforeAll(async () => {
  const res = await fetch(`${EXAMPLES}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-seed' }),
  });
  if (res.status !== 201) throw new Error(`seed POST failed: ${res.status} ${await res.text()}`);
  createdId = ((await res.json()) as Envelope<{ id: string }>).data!.id;
});

describe('stack liveness', () => {
  it('GET /healthz → live, correlation id echoed', async () => {
    const r = await call('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, data: { status: 'live' } });
    expect(r.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /readyz → ready proves PG reachable via PgBouncer AND pg-boss started', async () => {
    const r = await call('/readyz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, data: { status: 'ready' } });
  });
});

describe('conventions exercised by reference endpoints (validation line 169)', () => {
  it('happy path: POST example → 201 success envelope', async () => {
    const r = await call('/api/v1/examples', {
      method: 'POST',
      body: JSON.stringify({ name: 'smoke-happy' }),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect((r.body.data as { name: string }).name).toBe('smoke-happy');
  });

  it('idempotency-key replay returns the original row, flagged Idempotency-Replayed', async () => {
    const key = crypto.randomUUID();
    const first = await call('/api/v1/examples', {
      method: 'POST',
      body: JSON.stringify({ name: 'smoke-replay' }),
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const replayRes = await fetch(EXAMPLES, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ name: 'smoke-replay' }),
    });
    expect(replayRes.headers.get('idempotency-replayed')).toBe('true');
    const replay = (await replayRes.json()) as Envelope<{ id: string }>;
    expect(replay.data!.id).toBe((first.body.data as { id: string }).id);
  });

  it('VALIDATION_ERROR: invalid body → 422 failure envelope with safe details + requestId', async () => {
    const r = await call('/api/v1/examples', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });
    expect(r.status).toBe(422);
    expect(r.body.ok).toBe(false);
    expect(r.body.error!.code).toBe('VALIDATION_ERROR');
    expect(typeof r.body.error!.requestId).toBe('string');
    expect(JSON.stringify(r.body)).not.toMatch(/stack|sql/i);
  });

  it('NOT_FOUND: unknown resource and unknown route share one envelope shape', async () => {
    const missing = await call(`/api/v1/examples/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error!.code).toBe('NOT_FOUND');
    const unrouteable = await call('/api/v9/nope');
    expect(unrouteable.status).toBe(404);
    expect(unrouteable.body.error!.code).toBe('NOT_FOUND');
    expect(Object.keys(unrouteable.body.error!).sort()).toEqual(
      Object.keys(missing.body.error!).sort()
    );
  });

  it('created rows are actually durable in PG through PgBouncer', async () => {
    const r = await call(`/api/v1/examples/${createdId}`);
    expect(r.status).toBe(200);
    expect((r.body.data as { id: string }).id).toBe(createdId);
  });
});
