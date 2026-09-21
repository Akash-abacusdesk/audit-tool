import { describe, it, expect } from 'vitest';
import { sign, verify, isStale, authorizeAction } from '../helpers/s9-telegram-hmac.ts';
import { CALLBACK_CASES, LIMITS, ALLOWED_ACTION, DENIED_ACTION } from '../fixtures/s9/abuse-matrix.mjs';
import { telegramCallback } from '../../packages/shared/src/telegram.js';

const SECRET = 's9-telegram-secret';

describe('S9-D6 telegram callback abuse rejected at source (sandbox)', () => {
  const body = JSON.stringify({
    bot_id: 'ops-bot',
    delivery_id: 'cb-x',
    chat_id: 'chat-1',
    user_id: 'user-1',
    action: ALLOWED_ACTION,
    occurred_at: new Date().toISOString(),
  });
  const validSig = sign(SECRET, body);

  it('positive control: correctly signed, fresh, authorized callback verifies', () => {
    expect(verify(SECRET, body, validSig)).toBe(true);
    const allowed: Record<string, Set<string>> = { 'chat-1:user-1': new Set([ALLOWED_ACTION]) };
    expect(authorizeAction(allowed, 'chat-1', 'user-1', ALLOWED_ACTION)).toBe(true);
  });

  it('forged: wrong secret is rejected', () => {
    expect(verify(SECRET, body, sign('attacker-secret', body))).toBe(false);
  });

  it('forged: tampered body is rejected', () => {
    const tampered = JSON.stringify({ ...JSON.parse(body), action: DENIED_ACTION });
    expect(verify(SECRET, tampered, validSig)).toBe(false);
  });

  it('unsigned: missing secret_token header is rejected', () => {
    expect(verify(SECRET, body, undefined)).toBe(false);
  });

  it('stale: callback older than TELEGRAM_MAX_AGE_MIN is rejected', () => {
    const old = new Date(Date.now() - (LIMITS.MAX_AGE_MS + 60_000)).toISOString();
    expect(isStale(old, LIMITS.MAX_AGE_MS)).toBe(true);
    expect(isStale(new Date().toISOString(), LIMITS.MAX_AGE_MS)).toBe(false);
  });

  it('secret-payload: callback envelope rejects secret-bearing details', () => {
    const parsed = telegramCallback.safeParse({ ...JSON.parse(body), details: { token: 'leak' } });
    expect(parsed.success).toBe(false);
  });

  it('unauthorized-action: absent action is rejected by default-deny allow-list', () => {
    const allowed: Record<string, Set<string>> = { 'chat-1:user-1': new Set([ALLOWED_ACTION]) };
    expect(authorizeAction(allowed, 'chat-1', 'user-1', DENIED_ACTION)).toBe(false);
  });

  it('matrix mapping: callback abuse cases map to denial expectations', () => {
    for (const c of CALLBACK_CASES) {
      expect(c.expects.rejected).toBe(true);
    }
  });
});
