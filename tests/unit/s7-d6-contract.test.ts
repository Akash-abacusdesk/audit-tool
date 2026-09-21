import { describe, it, expect } from 'vitest';
import { ABUSE_CASES } from '../fixtures/prod-control/abuse-matrix.mjs';

// S7-D6 contract check — runs green at sandbox scope (no live prod-control service).
// Mirrors S5-D6: every abuse case must be well-formed and assert a *deny* with no
// remote change. The live rejection behaviour is exercised by the
// PROD_CONTROL_BASE_URL-gated integration battery and the prodctl source test.
describe('S7-D6 prod-control abuse matrix is well-formed and asserts denial', () => {
  it('matrix is non-empty and covers all six GO categories', () => {
    const cats = new Set(ABUSE_CASES.map((c) => c.category));
    expect(ABUSE_CASES.length).toBeGreaterThanOrEqual(6);
    for (const cat of ['arbitrary-exec', 'shell-invocation', 'malicious-args', 'shell-metachars', 'path-traversal', 'arg-validation']) {
      expect(cats.has(cat), `missing category ${cat}`).toBe(true);
    }
  });

  for (const c of ABUSE_CASES) {
    it(`${c.id}: request + rejection contract valid`, () => {
      expect(c.id).toMatch(/^pc-/);
      expect(typeof c.request.op).toBe('string');
      expect(typeof c.request.target).toBe('string');
      // Deny contract: rejection is a client-side (4xx) outcome, never a 5xx on abuse input.
      expect(c.expects.rejected).toBe(true);
      // Cross-cutting guarantee from the GO.
      expect(c.expects.noSideEffect).toBe(true);
    });
  }
});
