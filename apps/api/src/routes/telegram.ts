import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  ApiError,
  ok,
  telegramCallback,
  telegramAuthorizationInput,
  type TelegramAuthorizationDto,
  type TelegramCallbackIngestResult,
} from '@platform/shared';
import { requirePermission } from '../auth/service.js';
import {
  authorizeTelegramCallback,
  isStale,
  recordTelegramAudit,
  telegramDenyError,
  verify,
} from '../telegram/control.js';
import { duplicateTelegramWorkflow, runTelegramWorkflow } from '../telegram/workflows.js';
import type { Scheduler } from '../scheduler/scheduler.js';

interface Deps {
  pool: Pool;
  scheduler?: Scheduler;
}

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

function hdr(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const MAX_AGE_MS = Number(process.env.TELEGRAM_MAX_AGE_MIN ?? 10) * 60_000;
const BODY_LIMIT = Number(process.env.TELEGRAM_BODY_LIMIT_BYTES ?? 10_485_760);

/**
 * S9-D1 Telegram control plane.
 *   POST /api/v1/telegram/callback  — HMAC-secret-authenticated Bot-API webhook
 *   POST /api/v1/telegram/authorizations        — register a (chat,user) allow-list
 *   GET  /api/v1/telegram/authorizations        — list active bindings
 *   DELETE /api/v1/telegram/authorizations/:id  — revoke a binding
 */
export async function telegramRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  // Capture raw bytes for HMAC; tolerate a duplicate-registration error if the
  // webhook parser is already app-wide.
  try {
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
      (req as RawBodyRequest).rawBody = body;
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(new ApiError('VALIDATION_ERROR', 'malformed JSON body'), undefined);
      }
    });
  } catch {
    /* parser already present */
  }

  app.post('/telegram/callback', { bodyLimit: BODY_LIMIT }, async (req) => {
    const rawReq = req as RawBodyRequest;
    const raw = rawReq.rawBody;
    const secret = process.env.TELEGRAM_BOT_SECRET;
    const sigHeader = hdr(req, 'x-telegram-bot-api-secret-token');

    // Layer 1 — signature authentication over raw bytes. Generic 401 either way.
    if (typeof secret !== 'string' || typeof sigHeader !== 'string' || !raw) {
      await recordTelegramAudit(deps.pool, {
        actorId: null,
        action: 'telegram.callback.sig.deny',
        result: 'deny',
        resource: 'telegram:?',
        requestId: req.id,
        details: { ip: req.ip },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid signature');
    }
    if (!verify(secret, raw, sigHeader)) {
      await recordTelegramAudit(deps.pool, {
        actorId: null,
        action: 'telegram.callback.sig.deny',
        result: 'deny',
        resource: 'telegram:?',
        requestId: req.id,
        details: { ip: req.ip },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid signature');
    }

    // Layer 2 — parse + validate the (strict, secret-free) envelope.
    const parsed = telegramCallback.safeParse(req.body);
    if (!parsed.success) {
      await recordTelegramAudit(deps.pool, {
        actorId: null,
        action: 'telegram.callback.deny',
        result: 'deny',
        resource: 'telegram:?',
        requestId: req.id,
        details: { reason: 'invalid-envelope', issues: parsed.error.issues },
      });
      throw new ApiError('VALIDATION_ERROR', 'invalid callback envelope');
    }
    const cb = parsed.data;

    // Layer 3 — advisory freshness window (the PK dedup is authoritative).
    if (isStale(cb.occurred_at, MAX_AGE_MS)) {
      await recordTelegramAudit(deps.pool, {
        actorId: null,
        action: 'telegram.callback.stale.deny',
        result: 'deny',
        resource: `telegram:${cb.bot_id}/${cb.chat_id}`,
        requestId: req.id,
        details: { delivery_id: cb.delivery_id },
      });
      throw new ApiError('FORBIDDEN', 'stale callback');
    }

    // Layer 4 — FRESH-RBAC authorization (re-read allow-list per call).
    const authz = await authorizeTelegramCallback(deps.pool, cb);
    if (!authz.allowed) {
      await recordTelegramAudit(deps.pool, {
        actorId: null,
        action: 'telegram.callback.authz.deny',
        result: 'deny',
        resource: `telegram:${cb.bot_id}/${cb.chat_id}/${cb.user_id}`,
        requestId: req.id,
        details: { action: cb.action, reason: authz.reason },
      });
      throw telegramDenyError(authz.reason ?? 'unauthorized');
    }

    // Layer 5 — authoritative replay protection: UNIQUE(bot_id, delivery_id).
    const inserted = await deps.pool.query<{ id: string }>(
      `INSERT INTO telegram_callbacks (bot_id, delivery_id, chat_id, user_id, action, occurred_at, request_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (bot_id, delivery_id) DO NOTHING
       RETURNING id`,
      [
        cb.bot_id,
        cb.delivery_id,
        cb.chat_id,
        cb.user_id,
        cb.action,
        cb.occurred_at,
        cb.request_id ?? null,
        JSON.stringify(cb.details ?? {}),
      ]
    );
    const callbackId = inserted.rows[0]?.id ?? null;
    const workflow = callbackId
      ? await runTelegramWorkflow(cb, deps.scheduler)
      : duplicateTelegramWorkflow(cb);

    await recordTelegramAudit(deps.pool, {
      actorId: null,
      action: 'telegram.callback.ingest',
      result: callbackId ? 'allow' : 'deny',
      resource: `telegram:${cb.bot_id}/${cb.delivery_id}`,
      requestId: req.id,
      details: { action: cb.action, duplicate: !callbackId, workflow },
    });

    return ok({
      accepted: !!callbackId,
      duplicate: !callbackId,
      callback_id: callbackId,
    } satisfies TelegramCallbackIngestResult);
  });

  // ---- Management (RBAC-gated): maintain the per-(chat,user) allow-list ----

  app.post(
    '/telegram/authorizations',
    { preHandler: requirePermission('telegram.manage') },
    async (req) => {
      const input = telegramAuthorizationInput.parse(req.body);
      const actor = req.actor!;
      const res = await deps.pool.query<TelegramAuthorizationDto>(
        `INSERT INTO telegram_authorizations
           (bot_id, chat_id, user_id, actions, org_id, project_id, environment_id, created_by)
         VALUES ($1, $2, $3, $4::text[], $5::uuid, $6::uuid, $7::uuid, $8::uuid)
         ON CONFLICT (bot_id, chat_id, user_id) DO UPDATE
           SET actions = EXCLUDED.actions,
               org_id = EXCLUDED.org_id,
               project_id = EXCLUDED.project_id,
               environment_id = EXCLUDED.environment_id,
               revoked_at = NULL
         RETURNING id, bot_id, chat_id, user_id, actions, org_id::text, project_id::text,
                   environment_id::text, created_at, revoked_at`,
        [
          input.bot_id,
          input.chat_id,
          input.user_id,
          input.actions,
          input.scope?.orgId ?? null,
          input.scope?.projectId ?? null,
          input.scope?.environmentId ?? null,
          actor.user.id,
        ]
      );
      const row = res.rows[0]!;
      await recordTelegramAudit(deps.pool, {
        actorId: actor.user.id,
        action: 'telegram.authz.create',
        result: 'allow',
        resource: `telegram:${row.bot_id}/${row.chat_id}/${row.user_id}`,
        requestId: req.id,
        details: { id: row.id, actions: row.actions },
      });
      return ok(row);
    }
  );

  app.get(
    '/telegram/authorizations',
    { preHandler: requirePermission('telegram.manage') },
    async (req) => {
      const q = req.query as { bot_id?: string; chat_id?: string; include_revoked?: string };
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (typeof q.bot_id === 'string') {
        params.push(q.bot_id);
        clauses.push(`bot_id = $${params.length}`);
      }
      if (typeof q.chat_id === 'string') {
        params.push(q.chat_id);
        clauses.push(`chat_id = $${params.length}`);
      }
      if (q.include_revoked !== 'true') clauses.push('revoked_at IS NULL');
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const res = await deps.pool.query<TelegramAuthorizationDto>(
        `SELECT id, bot_id, chat_id, user_id, actions, org_id::text, project_id::text,
                environment_id::text, created_at, revoked_at
         FROM telegram_authorizations ${where}
         ORDER BY created_at DESC LIMIT 500`,
        params
      );
      return ok(res.rows);
    }
  );

  app.delete(
    '/telegram/authorizations/:id',
    { preHandler: requirePermission('telegram.manage') },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const res = await deps.pool.query<{ id: string }>(
        `UPDATE telegram_authorizations SET revoked_at = now()
         WHERE id = $1::uuid AND revoked_at IS NULL
         RETURNING id`,
        [id]
      );
      if (res.rows[0]?.id !== id) {
        throw new ApiError('NOT_FOUND', 'authorization not found or already revoked');
      }
      const actor = req.actor!;
      await recordTelegramAudit(deps.pool, {
        actorId: actor.user.id,
        action: 'telegram.authz.revoke',
        result: 'allow',
        resource: `telegram:authz/${id}`,
        requestId: req.id,
        details: { id },
      });
      return ok({ id, revoked: true });
    }
  );
}
