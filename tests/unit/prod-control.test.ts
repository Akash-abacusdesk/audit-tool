import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { ApiError, PERMISSIONS, ROLE_PERMISSIONS } from '@platform/shared';
import type { Actor } from '../../apps/api/src/auth/service.js';
import {
  PROD_CONTROL_PERMISSION,
  PROD_OPS,
  prodActionInput,
  requireApprovalRef,
  authorizeProdAction,
  recordProdAudit,
} from '../../apps/api/src/prod/control.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const APPROVAL = 'appr-1';

function managerActor(): Actor {
  return {
    user: { id: 'u-mgr', email: 'm@x.dev', displayName: 'M', isActive: true, createdAt: '2020-01-01T00:00:00.000Z' },
    sessionId: 's1',
    bindings: [{ role: 'manager', orgId: ORG, projectId: null, environmentId: null }],
  };
}

function fakeReq(actor: Actor, pool: Pick<Pool, 'query'>): FastifyRequest {
  return {
    actor,
    server: { pool } as never,
    method: 'POST',
    url: '/prod/commands',
    id: 'req-abc',
  } as unknown as FastifyRequest;
}

describe('S7-D1 prod-control authz/audit interface', () => {
  it('registers prod.execute and grants it to manager + security_admin', () => {
    expect(PERMISSIONS).toContain(PROD_CONTROL_PERMISSION);
    expect(ROLE_PERMISSIONS.manager).toContain(PROD_CONTROL_PERMISSION);
    expect(ROLE_PERMISSIONS.security_admin).toContain(PROD_CONTROL_PERMISSION);
  });

  it('mirrors the prodctl allow-list ops', () => {
    expect(PROD_OPS).toEqual(['inventory', 'health', 'deploy', 'plugin-update', 'rollback']);
  });

  it('parses a valid prod action and rejects a missing approvalId', () => {
    const ok = prodActionInput.safeParse({
      op: 'deploy',
      target: 'web',
      scope: { orgId: ORG },
      approvalId: APPROVAL,
    });
    expect(ok.success).toBe(true);
    const bad = prodActionInput.safeParse({ op: 'deploy', target: 'web', scope: { orgId: ORG } });
    expect(bad.success).toBe(false);
  });

  it('requireApprovalRef returns the id or throws VALIDATION_ERROR', () => {
    const valid = prodActionInput.parse({ op: 'deploy', target: 'web', scope: { orgId: ORG }, approvalId: APPROVAL });
    expect(requireApprovalRef(valid)).toBe(APPROVAL);
    const blank = prodActionInput.parse({ op: 'deploy', target: 'web', scope: { orgId: ORG }, approvalId: '   ' });
    expect(() => requireApprovalRef(blank)).toThrow(ApiError);
  });

  it('authorizes a scoped prod action and returns the correlation triple', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const auth = await authorizeProdAction(
      managerActor(),
      'req-abc',
      prodActionInput.parse({ op: 'deploy', target: 'web', scope: { orgId: ORG }, approvalId: APPROVAL }),
      pool
    );
    expect(auth).toEqual({ actorId: 'u-mgr', requestId: 'req-abc', approvalId: APPROVAL });
  });

  it('denies a prod action outside the actor scope (FORBIDDEN)', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    await expect(
      authorizeProdAction(
        managerActor(),
        'req-abc',
        prodActionInput.parse({ op: 'deploy', target: 'web', scope: { orgId: OTHER }, approvalId: APPROVAL }),
        pool
      )
    ).rejects.toThrow(ApiError);
  });

  it('records an audit event correlated to request + approval', async () => {
    const calls: unknown[] = [];
    const db = {
      query: async (...args: unknown[]) => {
        calls.push(args);
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pick<Pool, 'query'>;
    await recordProdAudit(db as never, {
      actorId: 'u-mgr',
      action: 'prod.deploy',
      result: 'allow',
      scope: { orgId: ORG },
      approvalId: APPROVAL,
      requestId: 'req-abc',
      resource: 'deploy/web',
    });
    expect(calls.length).toBe(1);
    const params = (calls[0] as unknown[])[1] as unknown[];
    expect(params[1]).toBe('prod.action');
    expect(params[7]).toBe('req-abc');
    expect((JSON.parse(params[8] as string) as { approvalId: string }).approvalId).toBe(APPROVAL);
  });
});
