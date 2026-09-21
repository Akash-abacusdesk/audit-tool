// S9-D6 abuse matrix. Canonical S9-D1 surface:
// POST /api/v1/telegram/callback, HMAC header X-Telegram-Bot-Api-Secret-Token,
// TELEGRAM_MAX_AGE_MIN=10m, UNIQUE(bot_id,delivery_id), fresh TELEGRAM_OPS
// authorizeAction default-deny.

export const S9_TELEGRAM_BASE = '/api/v1/telegram/callback';
export const S9_AUTHZ_BASE = '/api/v1/telegram/authorizations';
export const S9_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export const BOT_ID = 'ops-bot';
export const CHAT_ID = 'chat-1';
export const USER_ID = 'user-1';
export const ALLOWED_ACTION = 'deploy_approve';
export const DENIED_ACTION = 'restart_service';

const MAX_AGE_MS = Number(process.env.TELEGRAM_MAX_AGE_MIN ?? 10) * 60_000;

export const CALLBACK_CASES = [
  {
    id: 's9-tg-replay',
    category: 'telegram-replay',
    request: { method: 'POST', path: S9_TELEGRAM_BASE, delivery_id: 's9-replay', action: ALLOWED_ACTION },
    expects: { rejected: true, replayDedupe: true, status: 200 },
  },
  {
    id: 's9-tg-forged',
    category: 'telegram-forged',
    request: { method: 'POST', path: S9_TELEGRAM_BASE, delivery_id: 's9-forged', action: ALLOWED_ACTION, forgedSig: true },
    expects: { rejected: true, reason: 'bad-signature', code: 'UNAUTHORIZED', status: 401 },
  },
  {
    id: 's9-tg-unsigned',
    category: 'telegram-unsigned',
    request: { method: 'POST', path: S9_TELEGRAM_BASE, delivery_id: 's9-unsigned', action: ALLOWED_ACTION, unsigned: true },
    expects: { rejected: true, reason: 'bad-signature', code: 'UNAUTHORIZED', status: 401 },
  },
  {
    id: 's9-tg-expiry',
    category: 'telegram-expiry',
    request: { method: 'POST', path: S9_TELEGRAM_BASE, delivery_id: 's9-expired', action: ALLOWED_ACTION, expired: true },
    expects: { rejected: true, reason: 'stale', code: 'FORBIDDEN', status: 403 },
  },
  {
    id: 's9-tg-secret-payload',
    category: 'telegram-secret-payload',
    request: { method: 'POST', path: S9_TELEGRAM_BASE, delivery_id: 's9-secret-payload', action: ALLOWED_ACTION, secretPayload: true },
    expects: { rejected: true, reason: 'invalid-envelope', code: 'VALIDATION_ERROR', status: 422 },
  },
  {
    id: 's9-tg-unauthorized',
    category: 'telegram-unauthorized-action',
    request: { method: 'POST', path: S9_TELEGRAM_BASE, delivery_id: 's9-unauthorized', action: DENIED_ACTION },
    expects: { rejected: true, reason: 'forbidden', code: 'FORBIDDEN', status: 403 },
  },
];

export const ABUSE_CASES = [...CALLBACK_CASES];
export const LIMITS = { MAX_AGE_MS };
