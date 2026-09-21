import { describe, it, expect } from 'vitest';
import {
  ABUSE_CASES,
  WEBHOOK_CASES,
  JIT_CASES,
  LIMITS,
} from '../fixtures/s8/abuse-matrix.mjs';

// S8-D6 structural contract — pure sandbox check that the abuse matrix is
// well-formed and every case asserts a DENY (no allowed abuse). Green before the
// S8-D1/S8-D4 backends exist.
describe('S8-D6 abuse matrix (sandbox contract)', () => {
  it('covers both GO surfaces: webhook replay/forged/huge + JIT replay/token-reuse/expiry/revocation', () => {
    const cats = new Set(ABUSE_CASES.map((c) => c.category));
    for (const need of [
      'webhook-replay',
      'webhook-forged',
      'webhook-huge',
      'jit-replay',
      'jit-token-reuse',
      'jit-expiry',
      'jit-revocation',
    ]) {
      expect(cats.has(need), `missing abuse category ${need}`).toBe(true);
    }
  });

  it('every case must be denied (no abuse path is sanctioned)', () => {
    for (const c of ABUSE_CASES) {
      expect(c.expects.rejected, `${c.id} must assert rejected`).toBe(true);
    }
  });

  it('webhook surface has replay/forged/huge; replay denied by dedupe', () => {
    expect(WEBHOOK_CASES).toHaveLength(3);
    expect(WEBHOOK_CASES.find((c) => c.category === 'webhook-replay')?.expects.replayDedupe).toBe(true);
    expect(typeof LIMITS.MAX_BODY_BYTES).toBe('number');
    expect(LIMITS.MAX_BODY_BYTES).toBeGreaterThan(0);
  });

  it('JIT surface asserts single-use + expiry/revocation denial', () => {
    expect(JIT_CASES).toHaveLength(4);
    const single = JIT_CASES.filter((c) => c.expects.singleUse);
    expect(single).toHaveLength(2); // replay + token-reuse are the single-use denials
  });
});
