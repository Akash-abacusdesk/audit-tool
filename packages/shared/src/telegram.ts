/**
 * Section-9 contract surface (S9-D1): Telegram ops callback authorization +
 * just-in-time Telegram grant lifecycle DTOs.
 *
 * Canonical inbound endpoint: POST /api/v1/telegram/callback. The Telegram Bot
 * API pushes updates to this webhook; the `X-Telegram-Bot-Api-Secret-Token`
 * header (a SHA-256 HMAC of the raw body under the deployment secret) is the
 * sole credential. Every callback is authorized against a fresh, per
 * (chatId,userId) allow-list bound to an org/project/env scope (no stale perms),
 * and de-duplicated on (bot_id, delivery_id) so replays are idempotent.
 *
 * Signing scheme mirrors the git/S8 webhook verifiers (HMAC-SHA256 over the raw
 * request body, verified with timingSafeEqual) and the oracle helper
 * tests/helpers/s9-telegram-hmac.ts — sign/verify/isStale/authorizeAction are
 * the exact interfaces this module must satisfy.
 */

import { z } from 'zod';

/** Canonical ops-callback actions the platform recognizes. The DB allow-list
 *  may contain any of these; authorizeAction() checks membership exactly. */
export const TELEGRAM_OPS = [
  'status',
  'scan_trigger',
  'deploy_approve',
  'deploy_reject',
  'restart_service',
  'config_reload',
] as const;

export type TelegramOp = (typeof TELEGRAM_OPS)[number];

/** Keys that must NEVER appear in a Telegram payload (ops bots carry no
 *  platform secrets — defense-in-depth beyond the strict-schema below). */
const FORBIDDEN_KEY_FRAGMENTS = [
  'secret',
  'password',
  'passwd',
  'token',
  'credential',
  'api_key',
  'apikey',
  '.env',
  'source',
  'private_key',
];

function scanForForbiddenKeys(node: unknown, path = ''): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = scanForForbiddenKeys(node[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const lower = k.toLowerCase();
      if (FORBIDDEN_KEY_FRAGMENTS.some((f) => lower.includes(f))) return `${path}/${k}`;
      const hit = scanForForbiddenKeys(v, `${path}/${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Inbound Telegram ops callback payload. Strict (no .passthrough) so any
 * unexpected field — including a leaked secret/token — is rejected as 422. The
 * forbidden-key walk is a second guard in case a benign-looking key nests a
 * credential.
 */
export const telegramCallback = z
  .object({
    bot_id: z.string().min(1).max(200),
    delivery_id: z.string().min(1).max(200),
    chat_id: z.string().min(1).max(100),
    user_id: z.string().min(1).max(100),
    action: z.enum(TELEGRAM_OPS),
    occurred_at: z.string().datetime({ offset: true }),
    request_id: z.string().max(200).optional(),
    details: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((val: unknown, ctx: z.RefinementCtx) => {
    const hit = scanForForbiddenKeys(val);
    if (hit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `payload must not contain secret material (forbidden key ${hit})`,
      });
    }
  });

export type TelegramCallback = z.infer<typeof telegramCallback>;

export interface TelegramCallbackIngestResult {
  accepted: boolean;
  duplicate: boolean;
  callback_id: string | null;
}

/** Outcome of the fresh-RBAC authorization decision for a callback. */
export interface TelegramAuthorizationResult {
  allowed: boolean;
  reason?: 'no_binding' | 'unauthorized';
}

export const telegramAuthorizationInput = z.object({
  bot_id: z.string().min(1).max(200),
  chat_id: z.string().min(1).max(100),
  user_id: z.string().min(1).max(100),
  actions: z.array(z.string().min(1).max(80)).min(1).max(50),
  scope: z
    .object({
      orgId: z.string().uuid(),
      projectId: z.string().uuid().optional(),
      environmentId: z.string().uuid().optional(),
    })
    .optional(),
});

export type TelegramAuthorizationInput = z.infer<typeof telegramAuthorizationInput>;

export interface TelegramAuthorizationDto {
  id: string;
  bot_id: string;
  chat_id: string;
  user_id: string;
  actions: string[];
  org_id: string | null;
  project_id: string | null;
  environment_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

export const TELEGRAM_AUTHORIZATION_PERMISSION = 'telegram.manage' as const;
