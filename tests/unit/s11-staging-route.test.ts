import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { fail, toApiError } from '@platform/shared';
import { stagingRoutes, stagingStore } from '../../apps/api/src/routes/staging.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ENV = '33333333-3333-4333-8333-333333333333';

function makePool(role = 'manager') {
  const auditCalls: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('api_sessions')) {
        return { rows: [{ session_id: 's1', id: 'u-mgr', email: 'm@x', display_name: 'M', is_active: true, created_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes('api_role_bindings')) {
        return { rows: [{ role, org_id: ORG, project_id: null, environment_id: null }], rowCount: 1 };
      }
      if (sql.includes('api_audit_events')) {
        auditCalls.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, auditCalls };
}

async function buildApp(role = 'manager') {
  const { pool, auditCalls } = makePool(role);
  const boss = { send: vi.fn(async () => 'job-x') } as any;
  const app = Fastify({ logger: false, genReqId: (r) => (typeof r.headers['x-request-id'] === 'string' ? r.headers['x-request-id'] : 'fallback') });
  app.decorate('pool', pool);
  app.setErrorHandler((err, req, reply) => {
    const apiErr = toApiError(err);
    reply.status(apiErr.status).send(fail(apiErr.code, apiErr.message, apiErr.details, req.id));
  });
  await app.register(stagingRoutes, { prefix: '/api/v1', pool, boss });
  await app.ready();
  return { app, auditCalls, boss };
}

const headers = { authorization: 'Bearer tok', 'x-request-id': 'req-1', 'content-type': 'application/json' };

describe('S11-D1 staging routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stagingStore as any).runs.clear();
  });

  it('POST /staging provisions and enqueues (202)', async () => {
    const { app, boss } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staging',
      headers,
      payload: JSON.stringify({ projectId: PROJECT, environmentId: ENV, ref: 'main' }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.queued).toBe(true);
    expect(boss.send).toHaveBeenCalledWith('staging.provision', expect.objectContaining({ ref: 'main' }));
  });

  it('POST /staging rejects an actor lacking staging.manage (403)', async () => {
    const { app } = await buildApp('developer');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staging',
      headers,
      payload: JSON.stringify({ projectId: PROJECT, environmentId: ENV, ref: 'main' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /staging/:id/test-run refuses closed when the safety gate fails (403)', async () => {
    const { app } = await buildApp();
    const provisionRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staging',
      headers,
      payload: JSON.stringify({ projectId: PROJECT, environmentId: ENV, ref: 'main' }),
    });
    const { stagingId } = provisionRes.json().data;
    // Move requested -> provisioning -> ready so the ready-state gate is reachable.
    (stagingStore as any).runs.get(stagingId).state = 'ready';

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/staging/${stagingId}/test-run`,
      headers,
      payload: JSON.stringify({ suite: 'smoke', piiSanitized: false, integrationsNeutralized: true, noindexEnabled: true }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/pii not sanitized/);
  });

  it('POST /staging/:id/test-run enqueues once the environment is ready and safe (202)', async () => {
    const { app, boss } = await buildApp();
    const provisionRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staging',
      headers,
      payload: JSON.stringify({ projectId: PROJECT, environmentId: ENV, ref: 'main' }),
    });
    const { stagingId } = provisionRes.json().data;
    (stagingStore as any).runs.get(stagingId).state = 'ready';

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/staging/${stagingId}/test-run`,
      headers,
      payload: JSON.stringify({ suite: 'smoke', piiSanitized: true, integrationsNeutralized: true, noindexEnabled: true }),
    });
    expect(res.statusCode).toBe(202);
    expect(boss.send).toHaveBeenCalledWith('staging.test_run', expect.objectContaining({ stagingId, suite: 'smoke' }));
  });

  it('GET /staging/:id returns 404 for an unknown run', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/staging/nope', headers });
    expect(res.statusCode).toBe(404);
  });
});
