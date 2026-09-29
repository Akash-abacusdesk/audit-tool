import { describe, expect, it } from 'vitest';
import {
  WP_EVENT_SCHEMA_VERSION,
  WP_EVENT_TYPES,
  jitRedeemInput,
  jitRequestInput,
  jitRevokeInput,
  wpEventEnvelope,
} from '@platform/shared';

describe('S8-D1 contract: WP event envelope', () => {
  it('exposes the 11 mutation event types', () => {
    expect(WP_EVENT_TYPES).toHaveLength(11);
    expect(WP_EVENT_TYPES).toContain('jit.session_create');
    expect(WP_EVENT_TYPES).toContain('plugin_install');
  });

  const valid = {
    schema_version: WP_EVENT_SCHEMA_VERSION,
    site_id: 'site-1',
    delivery_id: 'd-1',
    event_type: 'admin_user_create',
    occurred_at: '2026-08-28T08:00:00Z',
    actor: { type: 'human', id: 'u1', ip: '1.2.3.4' },
  };

  it('accepts a well-formed envelope', () => {
    expect(wpEventEnvelope.parse(valid).site_id).toBe('site-1');
  });

  it('rejects an unknown event_type', () => {
    expect(() => wpEventEnvelope.parse({ ...valid, event_type: 'nope' })).toThrow();
  });

  it('rejects a wrong schema_version', () => {
    expect(() => wpEventEnvelope.parse({ ...valid, schema_version: 'x/1' })).toThrow();
  });
});

describe('S8-D1 contract: JIT DTOs', () => {
  it('validates a JIT request (reason + duration cap)', () => {
    const r = jitRequestInput.parse({ site_id: 's', reason: 'incident', duration_minutes: 30 });
    expect(r.duration_minutes).toBe(30);
    expect(() => jitRequestInput.parse({ site_id: 's', reason: 'x', duration_minutes: 999999 })).toThrow();
  });

  it('redeem needs the raw token (or, legacy, a 64-char hex token_hash)', () => {
    expect(() => jitRedeemInput.parse({ request_id: 'r' })).toThrow();
    expect(() => jitRedeemInput.parse({ request_id: 'r', token_hash: 'abc' })).toThrow();
    const hex = 'a'.repeat(64);
    expect(jitRedeemInput.parse({ request_id: 'r', token_hash: hex }).token_hash).toBe(hex);
    expect(jitRedeemInput.parse({ request_id: 'r', token: 'x'.repeat(32) }).token).toBe('x'.repeat(32));
  });

  it('validates a revoke input', () => {
    expect(jitRevokeInput.parse({ grant_id: 'grant_1' }).grant_id).toBe('grant_1');
  });
});

describe('bootstrap password policy', () => {
  it('holds the first (most privileged) account to the 12-char minimum', async () => {
    const { bootstrapInput } = await import('@platform/shared');
    const base = { email: 'a@x.io', displayName: 'A', orgName: 'O', orgSlug: 'o' };
    expect(bootstrapInput.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(bootstrapInput.safeParse({ ...base, password: 'long-enough-pw!' }).success).toBe(true);
  });
});
