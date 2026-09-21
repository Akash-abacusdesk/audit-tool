import { describe, it, expect } from 'vitest';
import { ABUSE_CASES, CALLBACK_CASES, LIMITS } from '../fixtures/s9/abuse-matrix.mjs';

describe('S9-D6 abuse matrix (sandbox contract)', () => {
  it('covers replay / expiry / unauthorized-action + signature + secret-payload abuse', () => {
    const cats = new Set(ABUSE_CASES.map((c) => c.category));
    for (const need of [
      'telegram-replay',
      'telegram-forged',
      'telegram-unsigned',
      'telegram-expiry',
      'telegram-secret-payload',
      'telegram-unauthorized-action',
    ]) {
      expect(cats.has(need), `missing abuse category ${need}`).toBe(true);
    }
  });

  it('every case must be denied or idempotent-deduped', () => {
    for (const c of ABUSE_CASES) {
      expect(c.expects.rejected, `${c.id} must assert rejected`).toBe(true);
    }
  });

  it('pins canonical S9-D1 status semantics', () => {
    expect(CALLBACK_CASES.find((c) => c.category === 'telegram-replay')?.expects.status).toBe(200);
    expect(CALLBACK_CASES.find((c) => c.category === 'telegram-forged')?.expects.status).toBe(401);
    expect(CALLBACK_CASES.find((c) => c.category === 'telegram-secret-payload')?.expects.status).toBe(422);
    expect(CALLBACK_CASES.find((c) => c.category === 'telegram-expiry')?.expects.status).toBe(403);
    expect(CALLBACK_CASES.find((c) => c.category === 'telegram-unauthorized-action')?.expects.status).toBe(403);
  });

  it('replay is denied by UNIQUE(bot_id,delivery_id) dedupe', () => {
    const replay = CALLBACK_CASES.find((c) => c.category === 'telegram-replay');
    expect(replay?.expects.replayDedupe).toBe(true);
  });

  it('stale window is a positive, bounded number', () => {
    expect(typeof LIMITS.MAX_AGE_MS).toBe('number');
    expect(LIMITS.MAX_AGE_MS).toBeGreaterThan(0);
  });
});
