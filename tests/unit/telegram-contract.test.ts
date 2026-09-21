/**
 * S9-D1 contract tier. Locks the public surface Oscar's S9-D6 live battery
 * depends on: the strict secret-free callback envelope, the forbidden-key
 * guard, and byte-for-byte parity between this module's sign/verify/isStale/
 * authorizeAction and the oracle helper tests/helpers/s9-telegram-hmac.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  telegramCallback,
  telegramAuthorizationInput,
  type TelegramCallback,
} from '../../packages/shared/src/index.js';
import {
  authorizeAction,
  authorizeTelegramCallback,
  isStale,
  sign,
  verify,
} from '../../apps/api/src/telegram/control.js';

// Parity reference: the exact 4 functions from oscar's oracle helper
// tests/helpers/s9-telegram-hmac.ts (S9-D6 scaffold). Inlined so this unit test
// has no cross-branch import (the helper lives on oscar's branch, not main) yet
// still locks my control.ts to the S9-D6 contract oscar tests against.
import { createHmac, timingSafeEqual } from 'node:crypto';
const ORACLE_RE = /^([0-9a-fA-F]{64})$/;
function oracleSign(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest().toString('hex');
}
function oracleVerify(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const hex = ORACLE_RE.exec(header)?.[1];
  if (!hex) return false;
  const given = Buffer.from(hex, 'hex');
  const mac = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === mac.length && timingSafeEqual(given, mac);
}
function oracleIsStale(dateHeader: string | undefined, maxAgeMs: number): boolean {
  if (typeof dateHeader !== 'string') return true;
  const sentAt = new Date(dateHeader).getTime();
  if (!Number.isFinite(sentAt)) return true;
  return Date.now() - sentAt > maxAgeMs;
}
function oracleAuthorize(
  allowed: Record<string, Set<string>>,
  chatId: string,
  userId: string,
  action: string,
): boolean {
  const key = `${chatId}:${userId}`;
  const perms = allowed[key];
  return perms ? perms.has(action) : false;
}

const goodCb = {
  bot_id: 'ops-bot',
  delivery_id: 'upd-123',
  chat_id: 'c1',
  user_id: 'u1',
  action: 'status' as const,
  occurred_at: new Date().toISOString(),
};

describe('telegram callback envelope: strict + secret-free', () => {
  it('accepts a well-formed callback', () => {
    expect(telegramCallback.safeParse(goodCb).success).toBe(true);
  });

  it('rejects unknown top-level keys (no passthrough)', () => {
    const r = telegramCallback.safeParse({ ...goodCb, unknown_field: 1 });
    expect(r.success).toBe(false);
  });

  it('rejects forbidden key fragments even nested in details', () => {
    expect(telegramCallback.safeParse({ ...goodCb, details: { password: 'x' } }).success).toBe(false);
    expect(telegramCallback.safeParse({ ...goodCb, details: { api_key: 'x' } }).success).toBe(false);
    expect(telegramCallback.safeParse({ ...goodCb, details: { source: 'env' } }).success).toBe(false);
  });

  it('allows benign details', () => {
    expect(telegramCallback.safeParse({ ...goodCb, details: { note: 'hi' } }).success).toBe(true);
  });

  it('rejects an action outside the declared ops enum', () => {
    expect(telegramCallback.safeParse({ ...goodCb, action: 'launch_nukes' }).success).toBe(false);
  });

  it('validates the management input shape', () => {
    expect(
      telegramAuthorizationInput.safeParse({
        bot_id: 'b',
        chat_id: 'c',
        user_id: 'u',
        actions: ['status'],
        scope: { orgId: '11111111-1111-1111-1111-111111111111' },
      }).success
    ).toBe(true);
  });
});

describe('telegram crypto + authz parity with S9-D6 oracle', () => {
  it('sign/verify behave identically to the oracle', () => {
    const secret = 's3cr3t';
    const body = Buffer.from('{"a":1}');
    const mac = oracleSign(secret, body);
    expect(sign(secret, body)).toBe(mac);
    expect(verify(secret, body, mac)).toBe(true);
    expect(oracleVerify(secret, body, mac)).toBe(true);
    expect(verify(secret, body, 'deadbeef')).toBe(false);
    expect(verify(secret, body, undefined)).toBe(false);
  });

  it('isStale behaves identically to the oracle', () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    expect(isStale(recent, 10 * 60_000)).toBe(oracleIsStale(recent, 10 * 60_000));
    expect(isStale(old, 10 * 60_000)).toBe(oracleIsStale(old, 10 * 60_000));
  });

  it('authorizeAction behaves identically to the oracle', () => {
    const allowed = { 'c1:u1': new Set(['status', 'restart_service']) };
    expect(authorizeAction(allowed, 'c1', 'u1', 'status')).toBe(
      oracleAuthorize(allowed, 'c1', 'u1', 'status')
    );
    expect(authorizeAction(allowed, 'c1', 'u1', 'deploy_approve')).toBe(
      oracleAuthorize(allowed, 'c1', 'u1', 'deploy_approve')
    );
    expect(authorizeAction(allowed, 'c2', 'u1', 'status')).toBe(
      oracleAuthorize(allowed, 'c2', 'u1', 'status')
    );
  });
});

describe('authorizeTelegramCallback: fresh default-deny', () => {
  const fakePool = (rows: { actions: string[] }[]) => ({
    query: async () => ({ rows }),
  });

  it('denies when no binding exists', async () => {
    const r = await authorizeTelegramCallback(fakePool([]) as any, goodCb as TelegramCallback);
    expect(r).toEqual({ allowed: false, reason: 'no_binding' });
  });

  it('allows when the action is in the fresh allow-list', async () => {
    const r = await authorizeTelegramCallback(
      fakePool([{ actions: ['status'] }]) as any,
      goodCb as TelegramCallback
    );
    expect(r).toEqual({ allowed: true });
  });

  it('denies when the action is absent from the allow-list', async () => {
    const r = await authorizeTelegramCallback(
      fakePool([{ actions: ['scan_trigger'] }]) as any,
      goodCb as TelegramCallback
    );
    expect(r).toEqual({ allowed: false, reason: 'unauthorized' });
  });
});
