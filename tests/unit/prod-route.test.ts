import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import Fastify from 'fastify';

vi.mock('@platform/prodctl', () => {
  class ProdCommandRejectedError extends Error {
    constructor(public reason: string) {
      super(`prod command rejected: ${reason}`);
      this.name = 'ProdCommandRejectedError';
    }
  }
  return {
    executeCommand: vi.fn(),
    ProdCommandRejectedError,
  };
});

import { executeCommand, ProdCommandRejectedError } from '@platform/prodctl';
import { prodRoutes } from '../../apps/api/src/routes/prod.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const APPROVAL = '33333333-3333-4333-8333-333333333333';

function makePool(role = 'manager', approvalValid = true) {
  const auditCalls: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('api_sessions')) {
        return {
          rows: [{ session_id: 's1', id: 'u-mgr', email: 'm@x', display_name: 'M', is_active: true, created_at: new Date() }],
          rowCount: 1,
        };
      }
      if (sql.includes('api_role_bindings')) {
        return { rows: [{ role, org_id: ORG, project_id: null, environment_id: null }], rowCount: 1 };
      }
      if (sql.includes('prod_approvals')) {
        if (sql.startsWith('INSERT')) return { rows: [{ id: APPROVAL, expires_at: new Date() }], rowCount: 1 };
        return { rows: approvalValid ? [{ id: APPROVAL }] : [], rowCount: approvalValid ? 1 : 0 };
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

async function buildApp(role = 'manager', approvalValid = true) {
  const { pool, auditCalls } = makePool(role, approvalValid);
  const app = Fastify({
    logger: false,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && h.length > 0 ? h : 'fallback';
    },
  });
  app.decorate('pool', pool);
  await app.register(prodRoutes, { prefix: '/api/v1' });
  await app.ready();
  return { app, auditCalls };
}

const baseHeaders = {
  authorization: 'Bearer tok',
  'x-request-id': 'req-1',
  'content-type': 'application/json',
};

const validPayload = { op: 'deploy', target: 'web', scope: { orgId: ORG }, approvalId: APPROVAL };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('S7-D1 prod-control route', () => {
  it('allows an authorized, approved op and audits it correlated to request+approval', async () => {
    vi.mocked(executeCommand).mockResolvedValue({ op: 'deploy', exitCode: 0, stdout: 'ok', stderr: '' });
    const { app, auditCalls } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/prod/commands',
      headers: baseHeaders,
      payload: JSON.stringify(validPayload),
    });
    expect(res.statusCode).toBe(200);
    expect(executeCommand).toHaveBeenCalledWith({ op: 'deploy', target: 'web' });
    expect(auditCalls.length).toBe(1);
    const p = auditCalls[0];
    expect(p[1]).toBe('prod.action');
    expect(p[7]).toBe('req-1');
    expect((JSON.parse(p[8] as string) as { approvalId: string }).approvalId).toBe(APPROVAL);
  });

  it('refuses a command whose approval is missing/used/mismatched (403) and never executes', async () => {
    const { app } = await buildApp('manager', false);
    const res = await app.inject({ method: 'POST', url: '/api/v1/prod/commands', headers: baseHeaders, payload: JSON.stringify(validPayload) });
    expect(res.statusCode).toBe(403);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid approvalId (422)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/prod/commands', headers: baseHeaders, payload: JSON.stringify({ ...validPayload, approvalId: 'appr-1' }) });
    expect(res.statusCode).toBe(422);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('POST /prod/approvals records an approval bound to the command (201)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/prod/approvals', headers: baseHeaders, payload: JSON.stringify({ op: 'deploy', target: 'web', scope: { orgId: ORG } }) });
    expect(res.statusCode).toBe(201);
    expect(res.json().approvalId).toBe(APPROVAL);
  });

  it('rejects an invalid body (missing approvalId) with 400', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/prod/commands',
      headers: baseHeaders,
      payload: JSON.stringify({ op: 'deploy', target: 'web', scope: { orgId: ORG } }),
    });
    expect(res.statusCode).toBe(422);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('denies an op outside the actor scope with 403', async () => {
    const { app, auditCalls } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/prod/commands',
      headers: baseHeaders,
      payload: JSON.stringify({ op: 'deploy', target: 'web', scope: { orgId: OTHER }, approvalId: APPROVAL }),
    });
    expect(res.statusCode).toBe(403);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(auditCalls.some((c) => String(c[1]).startsWith('authz.deny.'))).toBe(true);
  });

  it('returns 422 when prodctl hard-rejects the command (audited as deny)', async () => {
    vi.mocked(executeCommand).mockRejectedValue(new ProdCommandRejectedError('unknown op: sneak'));
    const { app, auditCalls } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/prod/commands',
      headers: baseHeaders,
      payload: JSON.stringify(validPayload),
    });
    expect(res.statusCode).toBe(422);
    const prodAudit = auditCalls.find((c) => c[1] === 'prod.action');
    expect(prodAudit).toBeDefined();
    expect(prodAudit![2]).toBe('deny');
    expect((JSON.parse(prodAudit![8] as string) as { deniedReason?: string }).deniedReason).toMatch(/unknown op/);
  });

  it('denies an actor lacking prod.execute with 403', async () => {
    const { app } = await buildApp('developer');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/prod/commands',
      headers: baseHeaders,
      payload: JSON.stringify(validPayload),
    });
    expect(res.statusCode).toBe(403);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
