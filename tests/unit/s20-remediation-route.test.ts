import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { fail, toApiError } from '@platform/shared';
import { remediationRoutes } from '../../apps/api/src/routes/remediation.js';
import { InMemoryRemediationStore } from '../../apps/api/src/ai-remediation/store.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const FINDING = '33333333-3333-4333-8333-333333333333';

function makePool(role = 'manager') {
  const auditCalls: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM api_projects')) return { rows: [{ org_id: ORG, env_ok: true }], rowCount: 1 };
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
  // the route now runs create + enqueue + audit in one transaction (withTx -> pool.connect)
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: pool.query.bind(pool), release: () => {} });
  return { pool, auditCalls };
}

async function buildApp(role = 'manager', schedulerEnabled = true) {
  const { pool, auditCalls } = makePool(role);
  const store = new InMemoryRemediationStore();
  const enqueue = vi.fn(async () => (schedulerEnabled ? 'job-x' : (() => { throw new Error('ai_remediation is disabled'); })()));
  const scheduler = { enqueue } as any;
  const app = Fastify({ logger: false, genReqId: (r) => (typeof r.headers['x-request-id'] === 'string' ? r.headers['x-request-id'] : 'fallback') });
  app.decorate('pool', pool);
  app.setErrorHandler((err, req, reply) => {
    const apiErr = toApiError(err);
    reply.status(apiErr.status).send(fail(apiErr.code, apiErr.message, apiErr.details, req.id));
  });
  await app.register(remediationRoutes, { prefix: '/api/v1', pool, scheduler, remediationStore: store });
  await app.ready();
  return { app, auditCalls, enqueue, store };
}

const headers = { authorization: 'Bearer tok', 'x-request-id': 'req-1', 'content-type': 'application/json' };
const body = { projectId: PROJECT, findingSummary: 'Hardcoded secret in config.js', codeContext: 'const key = "x";' };

describe('S20-D1 remediation routes', () => {
  it('POST /findings/:id/remediate creates a request and enqueues (202)', async () => {
    const { app, enqueue, auditCalls } = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/v1/findings/${FINDING}/remediate`, headers, payload: JSON.stringify(body) });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.queued).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('ai_remediation', expect.objectContaining({ kind: 'ai_remediation', findingId: FINDING }), expect.anything());
    expect(auditCalls.some((c) => String(c[1]).includes('remediation.request'))).toBe(true);
  });

  it('rejects an actor lacking finding.remediate — wait, developer HAS it; project_coordinator does not (403)', async () => {
    const { app } = await buildApp('project_coordinator');
    const res = await app.inject({ method: 'POST', url: `/api/v1/findings/${FINDING}/remediate`, headers, payload: JSON.stringify(body) });
    expect(res.statusCode).toBe(403);
  });

  it('developer role CAN request remediation (PRD §8.4: developer-triggered)', async () => {
    const { app } = await buildApp('developer');
    const res = await app.inject({ method: 'POST', url: `/api/v1/findings/${FINDING}/remediate`, headers, payload: JSON.stringify(body) });
    expect(res.statusCode).toBe(202);
  });

  it('surfaces the disabled-class error as a clean failure, not a crash', async () => {
    const { app } = await buildApp('manager', false);
    const res = await app.inject({ method: 'POST', url: `/api/v1/findings/${FINDING}/remediate`, headers, payload: JSON.stringify(body) });
    expect(res.statusCode).toBe(500);
  });

  it('GET /remediation-requests/:id returns 404 for an unknown request', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/remediation-requests/nope', headers });
    expect(res.statusCode).toBe(404);
  });

  it('GET /remediation-requests/:id reflects the store after job completion', async () => {
    const { app, store } = await buildApp();
    const created = await app.inject({ method: 'POST', url: `/api/v1/findings/${FINDING}/remediate`, headers, payload: JSON.stringify(body) });
    const { requestId } = created.json().data;
    await store.markCompleted(requestId, { patch: 'p', explanation: 'e', testGuidance: 't', provider: 'anthropic', model: 'claude-x' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/remediation-requests/${requestId}`, headers });
    expect(res.json().data.status).toBe('completed');
    expect(res.json().data.patch).toBe('p');
  });
});
