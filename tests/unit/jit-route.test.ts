import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { jitRoutes } from '../../apps/api/src/routes/jit.js';

const ORG = '11111111-1111-4111-8111-111111111111';

interface Store {
  requests: Map<string, { status: string; duration_minutes: number; site_id: string; created_by: string }>;
  tokens: Map<string, { request_id: string; consumed_at: Date | null; expires_at: Date }>;
  grants: Map<string, { status: string }>;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Two distinct sessions sharing one backing store: 'tok-req' resolves to the
// requester, 'tok-appr' to a different actor — approve/reject now enforce
// assertNotSelf, so a realistic lifecycle test needs two identities.
function makePool(actors: Record<string, { id: string; role: string }> = { 'tok-req': { id: 'u-mgr', role: 'manager' } }) {
  const store: Store = {
    requests: new Map(),
    tokens: new Map(),
    grants: new Map(),
  };
  const audit: unknown[][] = [];
  const byHash = new Map(Object.entries(actors).map(([tok, a]) => [hashToken(tok), a]));
  const query = async (sql: string, params?: unknown[]) => {
      if (sql.includes('api_sessions')) {
        const actor = byHash.get(params![0] as string);
        if (!actor) return { rows: [], rowCount: 0 };
        return {
          rows: [{ session_id: `s-${actor.id}`, id: actor.id, email: `${actor.id}@x`, display_name: actor.id, is_active: true, created_at: new Date() }],
          rowCount: 1,
        };
      }
      if (sql.includes('api_role_bindings')) {
        const targetId = params![0] as string;
        const found = [...byHash.values()].find((a) => a.id === targetId);
        return found
          ? { rows: [{ role: found.role, org_id: ORG, project_id: null, environment_id: null }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('api_audit_events')) {
        audit.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO jit_requests")) {
        store.requests.set(params![0] as string, {
          status: 'pending',
          duration_minutes: params![3] as number,
          site_id: params![1] as string,
          created_by: params![4] as string,
        });
        return { rows: [{ id: params![0] }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, status, duration_minutes, created_by FROM jit_requests")) {
        const r = store.requests.get(params![0] as string);
        return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT created_by, status FROM jit_requests')) {
        const r = store.requests.get(params![0] as string);
        return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO jit_tokens")) {
        store.tokens.set(params![0] as string, {
          request_id: params![1] as string,
          consumed_at: null,
          expires_at: params![2] as Date,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE jit_requests SET status = 'approved'")) {
        const r = store.requests.get(params![0] as string);
        if (r) r.status = 'approved';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT request_id, consumed_at, expires_at FROM jit_tokens')) {
        const t = store.tokens.get(params![0] as string);
        return t ? { rows: [t], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT site_id, duration_minutes FROM jit_requests')) {
        const r = store.requests.get(params![0] as string);
        return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE jit_tokens SET consumed_at')) {
        const t = store.tokens.get(params![0] as string);
        if (t) t.consumed_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO jit_grants')) {
        store.grants.set(params![0] as string, { status: 'active' });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE jit_grants SET status = 'revoked'")) {
        const g = store.grants.get(params![0] as string);
        if (g && g.status === 'active') {
          g.status = 'revoked';
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => Promise.resolve() }),
  } as unknown as Pool;
  return { pool, store, audit };
}

async function buildApp(pool: Pool) {
  const app = Fastify({ logger: false });
  app.decorate('pool', pool);
  await app.register(jitRoutes, { pool });
  await app.ready();
  return app;
}

const asRequester = { authorization: 'Bearer tok-req', 'content-type': 'application/json' };
const asApprover = { authorization: 'Bearer tok-appr', 'content-type': 'application/json' };
const auth = asRequester;

beforeEach(() => {});

describe('S8-D1 JIT grant lifecycle', () => {
  it('requests, approves, redeems once, and revokes a grant', async () => {
    // Two distinct actors: separation-of-duties (assertNotSelf) blocks the
    // requester from also being the approver.
    const { pool, store } = makePool({
      'tok-req': { id: 'u-dev', role: 'developer' },
      'tok-appr': { id: 'u-mgr', role: 'manager' },
    });
    const app = await buildApp(pool);

    const reqRes = await app.inject({
      method: 'POST',
      url: '/jit/requests',
      headers: asRequester,
      payload: { site_id: 'wp-1', reason: 'incident', duration_minutes: 15 },
    });
    expect(reqRes.statusCode).toBe(202);
    const requestId = reqRes.json().data.request_id as string;

    const approveRes = await app.inject({
      method: 'POST',
      url: `/jit/requests/${requestId}/approve`,
      headers: asApprover,
      payload: {},
    });
    if (approveRes.statusCode !== 200) console.error('APPROVE', approveRes.statusCode, approveRes.body);
    expect(approveRes.statusCode).toBe(200);
    const token = approveRes.json().data.token as string;
    expect(token).toBeTruthy();

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const redeemRes = await app.inject({
      method: 'POST',
      url: '/jit/redeem',
      headers: auth,
      payload: { request_id: requestId, token },
    });
    expect(redeemRes.statusCode).toBe(200);
    const grant = redeemRes.json().data;
    expect(grant.grant_id).toBeTruthy();
    expect(grant.ttl_seconds).toBe(15 * 60);
    expect(grant.site_id).toBe('wp-1');

    // One-time: a second redeem of the same token is rejected.
    const replay = await app.inject({
      method: 'POST',
      url: '/jit/redeem',
      headers: auth,
      payload: { request_id: requestId, token },
    });
    expect(replay.statusCode).toBe(409);

    // The stored hash alone is not a credential.
    const hashOnly = await app.inject({ method: 'POST', url: '/jit/redeem', headers: auth, payload: { request_id: requestId, token_hash: tokenHash } });
    expect(hashOnly.statusCode).toBe(422);

    // Revoke the grant (jit.revoke — the approver's role, not the requester's).
    const revoke = await app.inject({
      method: 'POST',
      url: `/jit/grants/${grant.grant_id}/revoke`,
      headers: asApprover,
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data.status).toBe('revoked');
    expect(store.grants.get(grant.grant_id)?.status).toBe('revoked');
  });

  it('lets a developer request but denies approve (jit.approve is team_lead+)', async () => {
    const { pool } = makePool();
    const app = await buildApp(pool);
    const devPool = {
      query: async (sql: string, _p?: unknown[]) => {
        if (sql.includes('api_sessions'))
          return { rows: [{ session_id: 's', id: 'u-dev', email: 'd@x', display_name: 'D', is_active: true, created_at: new Date() }], rowCount: 1 };
        if (sql.includes('api_role_bindings'))
          return { rows: [{ role: 'developer', org_id: ORG, project_id: null, environment_id: null }], rowCount: 1 };
        if (sql.includes('api_audit_events')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO jit_requests')) return { rows: [{ id: 'r-dev' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const devApp = Fastify({ logger: false });
    devApp.decorate('pool', devPool);
    await devApp.register(jitRoutes, { pool: devPool });
    await devApp.ready();
    const req = await devApp.inject({
      method: 'POST',
      url: '/jit/requests',
      headers: auth,
      payload: { site_id: 'wp-1', reason: 'x', duration_minutes: 5 },
    });
    expect(req.statusCode).toBe(202);
    const approve = await devApp.inject({
      method: 'POST',
      url: `/jit/requests/r-dev/approve`,
      headers: auth,
      payload: {},
    });
    expect(approve.statusCode).toBe(403);
  });

  it('blocks self-approval and self-rejection even when the requester holds jit.approve', async () => {
    const { pool } = makePool({ 'tok-req': { id: 'u-mgr', role: 'manager' } });
    const app = await buildApp(pool);

    const reqRes = await app.inject({
      method: 'POST',
      url: '/jit/requests',
      headers: asRequester,
      payload: { site_id: 'wp-1', reason: 'incident', duration_minutes: 15 },
    });
    const requestId = reqRes.json().data.request_id as string;

    const approve = await app.inject({
      method: 'POST',
      url: `/jit/requests/${requestId}/approve`,
      headers: asRequester,
      payload: {},
    });
    expect(approve.statusCode).toBe(403);

    const reject = await app.inject({
      method: 'POST',
      url: `/jit/requests/${requestId}/reject`,
      headers: asRequester,
      payload: {},
    });
    expect(reject.statusCode).toBe(403);
  });
});
