import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { fail, toApiError } from '@platform/shared';
import { updateRoutes } from '../../apps/api/src/routes/update.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ENV = '33333333-3333-4333-8333-333333333333';

interface Row {
  id: string;
  project_id: string;
  environment_id: string;
  component: string;
  from_version: string;
  to_version: string;
  state: string;
  created_at: Date;
}

/** Minimal stateful fake of api_update_units behind a real Pool shape. */
function makePool(role = 'manager', projectOrg = ORG) {
  const dupCheck = { on: false };
  const auditCalls: unknown[][] = [];
  const units = new Map<string, Row>();
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM api_projects')) return { rows: [{ org_id: projectOrg, env_ok: true }], rowCount: 1 };
      if (sql.includes('api_sessions')) {
        return { rows: [{ session_id: 's1', id: 'u-mgr', email: 'm@x', display_name: 'M', is_active: true, created_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes('api_role_bindings')) {
        return { rows: [{ role, org_id: ORG, project_id: null, environment_id: null }], rowCount: 1 };
      }
      if (sql.includes('FROM api_update_units') && sql.includes('to_version = $3')) {
        return dupCheck.on ? { rows: [{ id: 'existing' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('api_audit_events')) {
        auditCalls.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO api_update_units')) {
        const [projectId, environmentId, component, fromVersion, toVersion] = params as [string, string, string, string, string];
        const id = randomUUID();
        units.set(id, { id, project_id: projectId, environment_id: environmentId, component, from_version: fromVersion, to_version: toVersion, state: 'discovered', created_at: new Date() });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, project_id, environment_id, component')) {
        const [id] = params as [string];
        const r = units.get(id);
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (sql.startsWith('UPDATE api_update_units')) {
        const [id, state] = params as [string, string];
        const r = units.get(id);
        if (r) r.state = state;
        return { rows: [], rowCount: r ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  // routes now run their state change + job + audit in one transaction (withTx -> pool.connect)
  (pool as unknown as { connect: unknown }).connect = async () => ({ query: pool.query.bind(pool), release: () => {} });
  return { pool, auditCalls, units, dupCheck };
}

async function buildApp(role = 'manager', projectOrg = ORG) {
  const { pool, auditCalls, units, dupCheck } = makePool(role, projectOrg);
  const boss = { send: vi.fn(async () => 'job-x') } as any;
  const app = Fastify({ logger: false, genReqId: (r) => (typeof r.headers['x-request-id'] === 'string' ? r.headers['x-request-id'] : 'fallback') });
  app.decorate('pool', pool);
  app.setErrorHandler((err, req, reply) => {
    const apiErr = toApiError(err);
    reply.status(apiErr.status).send(fail(apiErr.code, apiErr.message, apiErr.details, req.id));
  });
  await app.register(updateRoutes, { prefix: '/api/v1', pool, boss });
  await app.ready();
  return { app, auditCalls, boss, units, dupCheck };
}

const headers = { authorization: 'Bearer tok', 'x-request-id': 'req-1', 'content-type': 'application/json' };
const createBody = { projectId: PROJECT, environmentId: ENV, component: 'elementor', fromVersion: '3.5.0', toVersion: '3.6.5' };

describe('S13-D1 update-unit routes', () => {
  it('POST /update-units creates a unit in the discovered state (201)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify(createBody) });
    expect(res.statusCode).toBe(201);
    const { id } = res.json().data;
    const get = await app.inject({ method: 'GET', url: `/api/v1/update-units/${id}`, headers });
    expect(get.json().data.state).toBe('discovered');
    expect(get.json().data.component).toBe('elementor');
  });

  it('POST /update-units rejects wp-cli flags in component/version (422)', async () => {
    const { app } = await buildApp();
    for (const bad of [{ component: '--exec=phpinfo();' }, { component: '--all' }, { toVersion: '1.0 --exec=x' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify({ ...createBody, ...bad }) });
      expect(res.statusCode).toBe(422);
    }
  });

  it('POST /update-units refuses a duplicate in-flight unit (409)', async () => {
    const { app, dupCheck } = await buildApp();
    dupCheck.on = true;
    const res = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify(createBody) });
    expect(res.statusCode).toBe(409);
  });

  it('POST /update-units refuses a project in another org (403)', async () => {
    const { app } = await buildApp('manager', '99999999-9999-4999-8999-999999999999');
    const res = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify(createBody) });
    expect(res.statusCode).toBe(403);
  });

  it('POST /update-units rejects an actor lacking update.manage (403)', async () => {
    const { app } = await buildApp('developer');
    const res = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify(createBody) });
    expect(res.statusCode).toBe(403);
  });

  it('transition(snapshot) enqueues a real job only after the state machine accepts it', async () => {
    const { app, boss } = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify(createBody) });
    const { id } = created.json().data;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/update-units/${id}/transition`,
      headers,
      payload: JSON.stringify({ event: 'snapshot' }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.state).toBe('restore_point');
    expect(res.json().data.queued).toBe(true);
    expect(boss.send).toHaveBeenCalledWith('update.snapshot', expect.objectContaining({ updateUnitId: id }), expect.objectContaining({ db: expect.anything() }));
  });

  it('transition(stage) refuses closed when staging is not ready — no job enqueued', async () => {
    const { app, boss } = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify(createBody) });
    const { id } = created.json().data;
    await app.inject({ method: 'POST', url: `/api/v1/update-units/${id}/transition`, headers, payload: JSON.stringify({ event: 'snapshot' }) });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/update-units/${id}/transition`,
      headers,
      payload: JSON.stringify({ event: 'stage', stagingReady: false }),
    });
    expect(res.statusCode).toBe(403);
    expect(boss.send).toHaveBeenCalledTimes(1); // only the earlier snapshot call
  });

  it('a full lifecycle to promoted enqueues exactly the 3 real-work jobs', async () => {
    const { app, boss } = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/update-units', headers, payload: JSON.stringify(createBody) });
    const { id } = created.json().data;

    const events: Array<{ event: string; stagingReady?: boolean }> = [
      { event: 'snapshot' },
      { event: 'stage', stagingReady: true },
      { event: 'staging_passed' },
      { event: 'functional_passed' },
      { event: 'visual_passed' },
      { event: 'approve' },
      { event: 'promote' },
    ];
    let lastState = '';
    for (const body of events) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/update-units/${id}/transition`, headers, payload: JSON.stringify(body) });
      expect(res.statusCode).toBe(202);
      lastState = res.json().data.state;
    }
    expect(lastState).toBe('promoted');
    expect(boss.send).toHaveBeenCalledTimes(3);
    expect(boss.send).toHaveBeenNthCalledWith(1, 'update.snapshot', expect.anything(), expect.objectContaining({ db: expect.anything() }));
    expect(boss.send).toHaveBeenNthCalledWith(2, 'update.stage', expect.anything(), expect.objectContaining({ db: expect.anything() }));
    expect(boss.send).toHaveBeenNthCalledWith(3, 'update.promote', expect.anything(), expect.objectContaining({ db: expect.anything() }));
  });

  it('GET /update-units/:id returns 404 for an unknown unit', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/update-units/nope', headers });
    expect(res.statusCode).toBe(404);
  });
});
