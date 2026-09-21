import { describe, expect, it } from 'vitest';
import { buildAuditWhere } from '../../apps/api/src/auth/audit.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

describe('buildAuditWhere', () => {
  it('emits TRUE with no filters and no cursor', () => {
    expect(buildAuditWhere({}, null)).toEqual({ where: 'TRUE', params: [] });
  });

  it('numbers params in filter order', () => {
    const { where, params } = buildAuditWhere(
      { actorId: USER, result: 'deny' },
      null
    );
    expect(where).toBe('actor_id = $1::uuid AND result = $2');
    expect(params).toEqual([USER, 'deny']);
  });

  it('cursor comes first, then filters', () => {
    const at = new Date('2026-08-22T00:00:00Z');
    const { where, params } = buildAuditWhere({ action: 'auth.login' }, { at, id: USER });
    expect(where).toBe('(created_at, id) < ($1::timestamptz, $2::uuid) AND action = $3');
    expect(params).toEqual([at.toISOString(), USER, 'auth.login']);
  });

  it('supports range bounds', () => {
    const from = new Date('2026-08-01T00:00:00Z');
    const to = new Date('2026-08-31T23:59:59Z');
    const { where } = buildAuditWhere({ from, to }, null);
    expect(where).toContain('created_at >= $1::timestamptz');
    expect(where).toContain('created_at <= $2::timestamptz');
  });
});
