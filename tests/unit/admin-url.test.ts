import { describe, expect, it } from 'vitest';
import { ADMIN_URL_PREFIXES, isAdminUrl } from '../../apps/api/src/auth/privileged.js';

describe('admin-plane URL classification (S4VAL-1)', () => {
  it('classifies every declared prefix at any registration root', () => {
    for (const p of ADMIN_URL_PREFIXES) {
      expect(isAdminUrl(`/api/v1${p}`), p).toBe(true);
      expect(isAdminUrl(p), p).toBe(true);
    }
  });

  it('scheduler plane: stats + job writes are gated, subpaths included', () => {
    expect(isAdminUrl('/api/v1/scheduler/stats')).toBe(true);
    expect(isAdminUrl('/api/v1/scheduler/jobs')).toBe(true);
    expect(isAdminUrl('/api/v1/scheduler/jobs/cancel')).toBe(true);
    expect(isAdminUrl('/api/v1/scheduler/stats?verbose=1')).toBe(true); // query stripped
    expect(isAdminUrl('/api/v1/scheduler/nested/x')).toBe(true); // prefix semantics
  });

  it('internal scheduler probes stay OUTSIDE the admin plane', () => {
    // token-guarded test-only surface; must not require management net/step-up
    expect(isAdminUrl('/api/v1/internal/scheduler/probe')).toBe(false);
    expect(isAdminUrl('/api/v1/internal/scheduler/probe/x/y')).toBe(false);
  });

  it('ordinary surfaces remain ungated; exact-prefix lookalikes do not match', () => {
    expect(isAdminUrl('/api/v1/examples')).toBe(false);
    expect(isAdminUrl('/api/v1/auth/me')).toBe(false);
    expect(isAdminUrl('/api/v1/usership')).toBe(false); // no partial-prefix match
  });
});
