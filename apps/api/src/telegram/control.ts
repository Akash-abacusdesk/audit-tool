/**
 * S9-D1: Telegram ops-callback authorization + audit correlation.
 *
 * This module is the authz/audit *interface* the Telegram callback webhook
 * (routes/telegram.ts) is wrapped with. It performs a FRESH, default-deny
 * RBAC check on every callback — the allow-list is re-read from the DB on each
 * request (no cached/stale permissions), mirroring the S7 prod-control posture.
 *
 * The pure helpers here are byte-for-byte behaviorally identical to
 * tests/helpers/s9-telegram-hmac.ts (sign/verify/isStale/authorizeAction) so
 * Oscar's S9-D6 live battery — which seeds via that oracle — exercises the
 * exact same decision surface.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { ApiError } from '@platform/shared';
import type { Queryable } from '../auth/audit.js';
import { recordAudit } from '../auth/audit.js';
import type { TelegramAuthorizationResult, TelegramCallback } from '@platform/shared';

export const TELEGRAM_CONTROL_PERMISSION = 'telegram.manage' as const;

const SIG_RE = /^([0-9a-fA-F]{64})$/;

/** HMAC-SHA256 hex of rawBody under secret. Identical to the oracle `sign`. */
export function sign(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest().toString('hex');
}

/** True only when header is a valid HMAC of rawBody under secret (oracle `verify`). */
export function verify(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const hex = SIG_RE.exec(header)?.[1];
  if (!hex) return false;
  const given = Buffer.from(hex, 'hex');
  const mac = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === mac.length && timingSafeEqual(given, mac);
}

/** Stale-callback check (oracle `isStale`): true when older than maxAgeMs. */
export function isStale(dateHeader: string | undefined, maxAgeMs: number): boolean {
  if (typeof dateHeader !== 'string') return true;
  const sentAt = new Date(dateHeader).getTime();
  if (!Number.isFinite(sentAt)) return true;
  return Date.now() - sentAt > maxAgeMs;
}

/**
 * Per-(chatId,userId) action authorization (oracle `authorizeAction`). The pure
 * decision the route applies; `allowed` is the fresh DB-derived allow-list.
 */
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

/**
 * FRESH-RBAC validation for a callback: re-read the (chatId,userId) allow-list
 * from the DB (no stale perms) and apply authorizeAction. Default-deny.
 */
export async function authorizeTelegramCallback(
  pool: Queryable,
  cb: TelegramCallback,
): Promise<TelegramAuthorizationResult> {
  const res = await pool.query<{ actions: string[] }>(
    `SELECT actions FROM telegram_authorizations
      WHERE bot_id = $1 AND chat_id = $2 AND user_id = $3 AND revoked_at IS NULL
      LIMIT 1`,
    [cb.bot_id, cb.chat_id, cb.user_id]
  );
  const row = res.rows[0];
  if (!row) return { allowed: false, reason: 'no_binding' };
  const allowed: Record<string, Set<string>> = {
    [`${cb.chat_id}:${cb.user_id}`]: new Set(row.actions),
  };
  return authorizeAction(allowed, cb.chat_id, cb.user_id, cb.action)
    ? { allowed: true }
    : { allowed: false, reason: 'unauthorized' };
}

export interface TelegramAuditInput {
  actorId: string | null;
  action: string;
  result: 'allow' | 'deny';
  resource: string;
  requestId: string;
  details?: unknown;
}

/** Emit a Telegram control-plane audit event. */
export async function recordTelegramAudit(db: Queryable, e: TelegramAuditInput): Promise<void> {
  await recordAudit(db, {
    actorId: e.actorId,
    action: e.action,
    result: e.result,
    resource: e.resource,
    requestId: e.requestId,
    details: e.details ?? {},
  });
}

/** Load a single active authorization binding (used by management routes). */
export async function loadTelegramAuthorization(
  pool: Pool,
  id: string,
): Promise<{ id: string; revoked_at: string | null } | null> {
  const res = await pool.query<{ id: string; revoked_at: string | null }>(
    `SELECT id, revoked_at FROM telegram_authorizations WHERE id = $1::uuid`,
    [id]
  );
  return res.rows[0] ?? null;
}

export function telegramDenyError(reason: 'no_binding' | 'unauthorized'): ApiError {
  return new ApiError('FORBIDDEN', `telegram action not authorized: ${reason}`);
}
