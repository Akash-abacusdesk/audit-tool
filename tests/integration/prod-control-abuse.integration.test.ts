import { describe, it, expect, beforeAll } from 'vitest';
import { ABUSE_CASES, PROD_CONTROL_BASE } from '../fixtures/prod-control/abuse-matrix.mjs';

// S7-D6 live prod-control abuse battery. Gated on env — set only when Jim's S7-D1
// route (POST /api/v1/prod-control/execute) + S7-D2 wrapper are live. Sandbox-inert else.
const BASE = process.env.PROD_CONTROL_BASE_URL ?? PROD_CONTROL_BASE;
const TOKEN = process.env.PROD_CONTROL_TOKEN ?? '';

async function postExecute(c: (typeof ABUSE_CASES)[number]) {
  const res = await fetch(BASE + '/api/v1/prod-control/execute', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(c.request),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
  return { status: res.status, body };
}

async function activeRunCount(): Promise<number> {
  const res = await fetch(BASE + '/runs', { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) return -1;
  const body = (await res.json().catch(() => ({}))) as { count?: number; runs?: unknown[] };
  return typeof body.count === 'number' ? body.count : Array.isArray(body.runs) ? body.runs.length : -1;
}

describe.skipIf(!process.env.PROD_CONTROL_BASE_URL)('S7-D6 prod-control abuse battery (live)', () => {
  beforeAll(() => {
    expect(TOKEN, 'PROD_CONTROL_TOKEN required for live battery').not.toBe('');
  });

  for (const c of ABUSE_CASES) {
    it(`${c.id}: ${c.category} rejected, no remote side effect`, async () => {
      const before = await activeRunCount();
      const { status, body } = await postExecute(c);
      const after = await activeRunCount();
      // denial: 4xx with envelope.ok === false (code-agnostic per fixture flip-point)
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(body.ok).toBe(false);
      // cross-cutting guarantee: a denied action makes NO remote change
      expect(after).toBe(before);
    });
  }
});
