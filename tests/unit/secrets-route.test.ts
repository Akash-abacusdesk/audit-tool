import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { secretsRoutes, secretsStore } from '../../apps/api/src/routes/secrets.js';

const ORG = '11111111-1111-4111-8111-111111111111';

function makePool(): Pool {
  const query = async (sql: string) => {
    if (sql.includes('api_sessions')) {
      return {
        rows: [{ session_id: 's1', id: 'u1', email: 'u@example.com', display_name: 'User', is_active: true, created_at: new Date() }],
        rowCount: 1,
      };
    }
    if (sql.includes('api_role_bindings')) {
      return { rows: [{ role: 'manager', org_id: ORG, project_id: null, environment_id: null }], rowCount: 1 };
    }
    if (sql.includes('api_audit_events')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { query } as unknown as Pool;
}

async function app() {
  const server = Fastify({ logger: false });
  server.decorate('pool', makePool());
  await server.register(secretsRoutes, { prefix: '/api/v1', pool: makePool() });
  await server.ready();
  return server;
}

const headers = { authorization: 'Bearer token', 'content-type': 'application/json' };

describe('S15 scoped secret route', () => {
  it('stores and reads non-Vaultwarden scoped secrets', async () => {
    const server = await app();
    const put = await server.inject({
      method: 'PUT',
      url: `/api/v1/secrets/${ORG}/deploy-token`,
      headers,
      payload: { value: 'scoped-value' },
    });
    expect(put.statusCode).toBe(200);

    const get = await server.inject({ method: 'GET', url: `/api/v1/secrets/${ORG}/deploy-token`, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.value).toBe('scoped-value');
  });

  it('denies direct Vaultwarden secret access through worker-facing scoped routes', async () => {
    const server = await app();
    await secretsStore.put({ orgId: ORG }, 'vaultwarden:root', 'never-return-this');

    const res = await server.inject({ method: 'GET', url: `/api/v1/secrets/${ORG}/vaultwarden:root`, headers });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/cannot access Vaultwarden directly/i);
  });
});
