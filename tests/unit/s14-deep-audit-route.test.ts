import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import {
  deepAuditRoutes,
  deepAuditStore,
} from '../../apps/api/src/routes/deep-audit.js';
import type { DeepAuditTarget } from '@platform/shared';

vi.mock('../../apps/api/src/deep-audit/queue.js', () => {
  const sent: any[] = [];
  return {
    DeepAuditStore: class {
      create(t: any) {
        return 'stored-' + sent.length;
      }
      get() {
        return null;
      }
      setResult() {}
    },
    DeepAuditQueue: class {
      constructor() {}
      async enqueuePipeline(_id: string, target: DeepAuditTarget) {
        sent.push(target);
        return ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7'];
      }
    },
  };
});

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
  await app.register(deepAuditRoutes, { prefix: '/api/v1', pool, boss });
  await app.ready();
  return { app, auditCalls };
}

const headers = { authorization: 'Bearer tok', 'x-request-id': 'req-1', 'content-type': 'application/json' };
const stagingBody = { projectId: PROJECT, environmentId: ENV, environment: 'staging', ref: 'main', isolatedEnv: true };

describe('S14-D3 deep-audit routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys((deepAuditStore as any).runs)) delete (deepAuditStore as any).runs[k];
  });

  it('POST /run enqueues a 7-stage pipeline for a staging target (202)', async () => {
    const { app, auditCalls } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/deep-audit/run', headers, payload: JSON.stringify(stagingBody) });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.stages).toBe(7);
    expect(auditCalls.some((c) => String(c[1]).includes('audit.deep'))).toBe(true);
  });

  it('POST /run refuses a production target with 422', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/deep-audit/run',
      headers,
      payload: JSON.stringify({ ...stagingBody, environment: 'production' }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /run rejects an actor lacking audit.deep (403)', async () => {
    const { app } = await buildApp('developer');
    const res = await app.inject({ method: 'POST', url: '/api/v1/deep-audit/run', headers, payload: JSON.stringify(stagingBody) });
    expect(res.statusCode).toBe(403);
  });

  it('GET /:id returns 404 for an unknown run', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/deep-audit/nope', headers });
    expect(res.statusCode).toBe(404);
  });

  it('GET /:id returns the report once a run completes', async () => {
    const { app } = await buildApp();
    const run = deepAuditStore.create(stagingBody as any);
    (deepAuditStore as any).runs.get(run).report = {
      id: run,
      target: stagingBody,
      severityCounts: { critical: 1, high: 0, medium: 0, low: 0, info: 0, total: 1 },
      stageStatus: {},
      findings: [],
    };
    const res = await app.inject({ method: 'GET', url: `/api/v1/deep-audit/${run}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.severityCounts.total).toBe(1);
  });
});
