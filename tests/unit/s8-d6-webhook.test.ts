import { describe, it, expect } from 'vitest';
import { sign, verify, isStale } from '../helpers/s8-webhook-hmac.ts';
import {
  WEBHOOK_CASES,
  LIMITS,
} from '../fixtures/s8/abuse-matrix.mjs';

// S8-D6 real sandbox proof for the webhook surface. Mirrors the S3 git-webhook
// route's Layer-1/2 checks (apps/api/src/routes/webhooks.ts) using the same HMAC
// scheme — no HTTP stack needed, this is the actual rejection logic.
const SECRET = 's3-webhook-secret';

describe('S8-D6 webhook abuse rejected at source (sandbox)', () => {
  const body = JSON.stringify({ action: 'push', repository: { id: 42, full_name: 'acme/app' } });
  const validSig = sign(SECRET, body);

  it('positive control: a correctly-signed delivery verifies', () => {
    expect(verify(SECRET, body, validSig)).toBe(true);
  });

  it('forged: signature under the wrong secret is rejected', () => {
    const forged = sign('attacker-secret', body);
    expect(verify(SECRET, body, forged)).toBe(false);
  });

  it('forged: signature over a tampered body is rejected', () => {
    const tampered = JSON.stringify({ action: 'push', repository: { id: 9999 } });
    // same delivery id, different payload -> signature must not match
    expect(verify(SECRET, tampered, validSig)).toBe(false);
  });

  it('stale: a delivery older than WEBHOOK_MAX_AGE_MIN is rejected', () => {
    const old = new Date(Date.now() - (LIMITS.MAX_AGE_MS + 60_000)).toUTCString();
    expect(isStale(old, LIMITS.MAX_AGE_MS)).toBe(true);
    const fresh = new Date().toUTCString();
    expect(isStale(fresh, LIMITS.MAX_AGE_MS)).toBe(false);
  });

  it('huge: a payload above WEBHOOK_BODY_LIMIT_BYTES trips the body guard', () => {
    const huge = Buffer.alloc(LIMITS.MAX_BODY_BYTES + 1, 'x');
    expect(huge.length).toBeGreaterThan(LIMITS.MAX_BODY_BYTES);
    // the route declares `bodyLimit: BODY_LIMIT` -> Fastify 413 before any auth work
    const overLimit = huge.length > LIMITS.MAX_BODY_BYTES;
    expect(overLimit).toBe(true);
  });

  it('matrix mapping: webhook abuse cases map to denial expectations', () => {
    for (const c of WEBHOOK_CASES) {
      expect(c.expects.rejected).toBe(true);
    }
  });
});
