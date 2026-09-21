// S9-D6 Telegram ops callback HMAC helper (D6 / oscar). Matches
// apps/api/src/telegram/control.ts exactly: HMAC-SHA256 hex over raw body,
// timingSafeEqual compare, stale-window check, per-(chatId,userId) allow-list.
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_RE = /^([0-9a-fA-F]{64})$/;

export function sign(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest().toString('hex');
}

export function verify(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const hex = SIG_RE.exec(header)?.[1];
  if (!hex) return false;
  const given = Buffer.from(hex, 'hex');
  const mac = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === mac.length && timingSafeEqual(given, mac);
}

export function isStale(dateHeader: string | undefined, maxAgeMs: number): boolean {
  if (typeof dateHeader !== 'string') return true;
  const sentAt = new Date(dateHeader).getTime();
  if (!Number.isFinite(sentAt)) return true;
  return Date.now() - sentAt > maxAgeMs;
}

export function authorizeAction(
  allowed: Record<string, Set<string>>,
  chatId: string,
  userId: string,
  action: string,
): boolean {
  const key = `${chatId}:${userId}`;
  const perms = allowed[key];
  return perms ? perms.has(action) : false;
}
