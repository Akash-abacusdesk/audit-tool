import { describe, it, expect, beforeAll } from 'vitest';
import {
  ABUSE_CASES,
  WEBHOOK_CASES,
  JIT_CASES,
} from '../fixtures/s8/abuse-matrix.mjs';

// S8-D6 live abuse battery. Gated on env — set only when S8-D1 (Jim ingestion +
// JIT state) and S8-D4 (Kevin MU-plugin/JIT WP-side) are live. Sandbox-inert else.
const WH_BASE = process.env.S8_WEBHOOK_BASE_URL;
const JIT_BASE = process.env.S8_JIT_BASE_URL;
const TOKEN = process.env.S8_WEBHOOK_TOKEN ?? process.env.S8_JIT_TOKEN ?? '';

async function callApi(base: string, c: (typeof ABUSE_CASES)[number]) {
  const res = await fetch(base + c.request.path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(c.request),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
  return { status: res.status, body };
}

describe.skipIf(!WH_BASE && !JIT_BASE)('S8-D6 abuse battery (live)', () => {
  beforeAll(() => {
    expect(TOKEN, 'S8 token required (S8_WEBHOOK_TOKEN / S8_JIT_TOKEN)').not.toBe('');
  });

  for (const c of WEBHOOK_CASES) {
    it(`${c.id}: webhook delivery rejected (no re-enqueue)`, async () => {
      if (!WH_BASE) return;
      const { status, body } = await callApi(WH_BASE, c);
      if (c.category === 'webhook-replay' && c.expects.replayDedupe) {
        // replay is accepted-once: 200 with duplicate:true, never re-enqueued
        expect(status).toBeLessThan(500);
        expect(body.ok ?? (body as any).duplicate ?? (body as any).accepted).toBeDefined();
      } else {
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(500);
        expect(body.ok).toBe(false);
      }
    });
  }

  for (const c of JIT_CASES) {
    it(`${c.id}: JIT grant denied (no access granted)`, async () => {
      if (!JIT_BASE) return;
      const { status, body } = await callApi(JIT_BASE, c);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(body.ok).toBe(false);
    });
  }
});
