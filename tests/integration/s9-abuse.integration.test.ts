import { beforeAll, describe, expect, it } from 'vitest';
import { sign } from '../helpers/s9-telegram-hmac.ts';
import {
  ALLOWED_ACTION,
  BOT_ID,
  CALLBACK_CASES,
  CHAT_ID,
  DENIED_ACTION,
  LIMITS,
  S9_AUTHZ_BASE,
  S9_SECRET_HEADER,
  USER_ID,
} from '../fixtures/s9/abuse-matrix.mjs';

const BASE = process.env.S9_TELEGRAM_BASE_URL;
const TOKEN = process.env.S9_TELEGRAM_TOKEN ?? '';
const SECRET = process.env.S9_TELEGRAM_SECRET ?? process.env.TELEGRAM_BOT_SECRET ?? 'dev-telegram-secret';
const RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

type AbuseCase = (typeof CALLBACK_CASES)[number];
type Envelope = { ok?: boolean; error?: { code?: string }; data?: { accepted?: boolean; duplicate?: boolean } };

function payload(c: AbuseCase) {
  const old = new Date(Date.now() - (LIMITS.MAX_AGE_MS + 60_000)).toISOString();
  return {
    bot_id: BOT_ID,
    delivery_id: `${c.request.delivery_id}-${RUN_ID}`,
    chat_id: CHAT_ID,
    user_id: USER_ID,
    action: c.category === 'telegram-unauthorized-action' ? DENIED_ACTION : ALLOWED_ACTION,
    occurred_at: c.request.expired ? old : new Date().toISOString(),
    ...(c.request.secretPayload ? { details: { token: 'must-not-cross' } } : {}),
  };
}

async function callCallback(c: AbuseCase, reusePayload?: ReturnType<typeof payload>) {
  const body = JSON.stringify(reusePayload ?? payload(c));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!c.request.unsigned) {
    headers[S9_SECRET_HEADER] = c.request.forgedSig ? sign('attacker-secret', body) : sign(SECRET, body);
  }
  const res = await fetch(BASE + c.request.path, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as Envelope;
  return { status: res.status, body: json };
}

async function seedAuthorization() {
  const res = await fetch(BASE + S9_AUTHZ_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ bot_id: BOT_ID, chat_id: CHAT_ID, user_id: USER_ID, actions: [ALLOWED_ACTION] }),
  });
  expect(res.status).toBeLessThan(300);
}

describe.skipIf(!BASE)('S9-D6 telegram callback abuse battery (live)', () => {
  beforeAll(async () => {
    expect(TOKEN, 'S9_TELEGRAM_TOKEN required to seed /api/v1/telegram/authorizations').not.toBe('');
    await seedAuthorization();
  });

  for (const c of CALLBACK_CASES) {
    it(`${c.id}: ${c.category}`, async () => {
      if (c.category === 'telegram-replay') {
        const p = payload(c);
        const first = await callCallback(c, p);
        expect(first.status).toBe(200);
        expect(first.body.ok).toBe(true);
        expect(first.body.data?.accepted).toBe(true);
        expect(first.body.data?.duplicate).toBe(false);
        const second = await callCallback(c, p);
        expect(second.status).toBe(200);
        expect(second.body.ok).toBe(true);
        expect(second.body.data?.accepted).toBe(false);
        expect(second.body.data?.duplicate).toBe(true);
        return;
      }

      const { status, body } = await callCallback(c);
      expect(status).toBe(c.expects.status);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe(c.expects.code);
    });
  }
});
