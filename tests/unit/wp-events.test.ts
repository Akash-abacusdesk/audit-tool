import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { wpEventRoutes } from '../../apps/api/src/routes/wp.js';

const SECRET = 'test-wp-secret';
const SITE = 'site-1';

function makePool() {
  const seen = new Set<string>();
  const audit: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('api_audit_events')) {
        audit.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('wp_event_signing_keys')) {
        return { rows: [{ secret: SECRET }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO wp_events')) {
        const key = `${params![0] as string}|${params![1] as string}`;
        if (seen.has(key)) return { rows: [], rowCount: 0 };
        seen.add(key);
        return { rows: [{ id: `evt-${seen.size}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, audit };
}

function buildApp(pool: Pool) {
  const app = Fastify({ logger: false });
  app.decorate('pool', pool);
  return app.register(wpEventRoutes, { pool });
}

const body = {
  schema_version: 'wp-mutation-events/1.0',
  site_id: SITE,
  delivery_id: 'd-1',
  event_type: 'admin_user_create',
  occurred_at: new Date().toISOString(),
  actor: { type: 'human', id: 'u1', ip: '1.2.3.4' },
};

function sig(raw: string) {
  return 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
}

beforeEach(() => {
  process.env.S8_WP_EVENT_SECRET = SECRET;
});

describe('S8-D1 WP event ingest', () => {
  it('rejects a forged signature with 401', async () => {
    const { pool } = makePool();
    const app = await buildApp(pool);
    const raw = JSON.stringify(body);
    const res = await app.inject({
      method: 'POST',
      url: '/wp/mutation-events',
      headers: { 'content-type': 'application/json', 'x-wp-signature': 'sha256=' + '0'.repeat(64) },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a genuine signature and persists the event', async () => {
    const { pool } = makePool();
    const app = await buildApp(pool);
    const raw = JSON.stringify(body);
    const res = await app.inject({
      method: 'POST',
      url: '/wp/mutation-events',
      headers: { 'content-type': 'application/json', 'x-wp-signature': sig(raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.ok).toBe(true);
    expect(out.data.duplicate).toBe(false);
    expect(out.data.event_id).toBeTruthy();
  });

  it('treats a replayed delivery_id as a duplicate (idempotent 200)', async () => {
    const { pool } = makePool();
    const app = await buildApp(pool);
    const raw = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'x-wp-signature': sig(raw) };
    const first = await app.inject({ method: 'POST', url: '/wp/mutation-events', headers, payload: raw });
    const second = await app.inject({ method: 'POST', url: '/wp/mutation-events', headers, payload: raw });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.duplicate).toBe(true);
    expect(second.json().data.event_id).toBeNull();
  });

  it('accepts the case-insensitive X-WP-Signature header from Kevin plugin', async () => {
    const { pool } = makePool();
    const app = await buildApp(pool);
    const raw = JSON.stringify({ ...body, delivery_id: 'd-kevin' });
    const res = await app.inject({
      method: 'POST',
      url: '/wp/mutation-events',
      headers: { 'content-type': 'application/json', 'X-WP-Signature': sig(raw), 'X-WP-Site': SITE },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.duplicate).toBe(false);
  });
});
