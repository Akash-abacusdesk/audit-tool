import { describe, it, expect } from 'vitest';
import { resolveCommand, ProdCommandRejectedError } from '../../packages/prodctl/src/index.js';
import { ABUSE_CASES } from '../fixtures/prod-control/abuse-matrix.mjs';

// S7-D6 REAL sandbox proof (no Docker / no HTTP stack needed): every abuse case in
// the matrix must be rejected by the actual @platform/prodctl allow-list BEFORE any
// command executes. This directly exercises Dwight's S7-D2 wrapper source, proving
// the abuse battery's rejection semantics hold. The live HTTP battery
// (prod-control-abuse.integration.test.ts) re-checks the same contract through Jim's
// S7-D1 route on CI.
describe('S7-D6 abuse cases are rejected by the prodctl wrapper (sandbox)', () => {
  for (const c of ABUSE_CASES) {
    it(`${c.id}: rejected before execution`, () => {
      expect(() => resolveCommand({ op: c.request.op, target: c.request.target } as never)).toThrow(
        ProdCommandRejectedError,
      );
    });
  }

  it('positive control: a legit allow-listed op/target resolves (sanity)', () => {
    const { bin, argv } = resolveCommand({ op: 'health', target: 'web' });
    expect(bin).toBe('/usr/bin/kubectl');
    expect(argv).toContain('web');
  });
});
