import { describe, expect, it } from 'vitest';
import { createLimiter } from '../../apps/api/src/util/rate-limit.js';

describe('createLimiter', () => {
  it('hit() trips after max and keys are independent', () => {
    const l = createLimiter(2, 60_000);
    expect([l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([false, false, true]);
    expect(l.hit('b')).toBe(false);
  });

  it('blocked() only counts recorded failures', () => {
    const l = createLimiter(2, 60_000);
    expect(l.blocked('x')).toBe(false);
    l.record('x');
    expect(l.blocked('x')).toBe(false);
    l.record('x');
    expect(l.blocked('x')).toBe(true);
  });
});
