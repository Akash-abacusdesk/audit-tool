import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ApiError, ok } from '@platform/shared';
import { recordAudit } from '../auth/audit.js';
import { bearerOf, requireAuth, resolveActor } from '../auth/service.js';
import { verifyPassword } from '../auth/passwords.js';
import {
  assertFreshStepUp,
  assertManagementNetwork,
  assertSpoolHasRoom,
  isAdminUrl,
} from '../auth/privileged.js';

interface Deps {
  pool: Pool;
}

/**
 * Root-scope admin-plane gate. MUST be awaited before adminRoutes registers:
 * Fastify children snapshot inherited hooks at register() time.
 */
export async function adminGate(app: FastifyInstance, deps: Deps): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (!isAdminUrl(req.url)) return;
    await assertManagementNetwork(req);
    const token = bearerOf(req);
    if (!token) return;
    req.actor = (await resolveActor(deps.pool, token)) ?? undefined;
    if (!req.actor) return;
    const res = await deps.pool.query<{ step_up_at: Date | null }>(
      'SELECT step_up_at FROM api_sessions WHERE id = $1::uuid AND revoked_at IS NULL',
      [req.actor.sessionId]
    );
    req.stepUpAt = res.rows[0]?.step_up_at ?? null;
    await assertFreshStepUp(req);
  });
}

// ponytail: in-memory limiter is per-process; move to a shared store if the API ever scales out.
const attempts = new Map<string, number[]>();
const MAX_ATTEMPTS = Number(process.env.ADMIN_STEPUP_MAX_ATTEMPTS ?? 5);
const WINDOW_MS = Number(process.env.ADMIN_STEPUP_WINDOW_MIN ?? 15) * 60_000;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, recent);
  return recent.length >= MAX_ATTEMPTS;
}

function recordAttempt(key: string): void {
  const list = attempts.get(key) ?? [];
  list.push(Date.now());
  attempts.set(key, list);
}

export async function securityRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:security enter');

  /**
   * Admin-plane gate for every admin.ts route — enforced here so no existing
   * route file changes: management-network origin + fresh step-up proof.
   * A missing/invalid token is left to each route's own requirePermission so
   * error codes stay canonical (401 before 403 semantics).
   *
   * Registered via adminGate() on the ROOT app BEFORE adminRoutes mounts:
   * app.register() scopes addHook to this plugin's own encapsulation context,
   * so a hook added inside securityRoutes would never cover sibling admin
   * routes (caught live: /users returned 200 pre-step-up).
   */

  /**
   * Step-up proof: re-verifies the password on an ALREADY authenticated
   * session and stamps it privileged for ADMIN_STEPUP_TTL_MIN.
   * Blocked while the audit export spool is full (spool-full policy).
   */
  app.post(
    '/auth/step-up',
    { preHandler: [assertManagementNetwork, requireAuth] },
    async (req) => {
      await assertSpoolHasRoom(req);
      const body = (req.body ?? {}) as { password?: unknown };
      if (typeof body.password !== 'string' || body.password.length === 0) {
        throw new ApiError('VALIDATION_ERROR', 'password is required');
      }
      const actor = req.actor!;
      if (rateLimited(actor.user.id)) {
        await recordAudit(deps.pool, {
          actorId: actor.user.id,
          action: 'auth.stepup',
          result: 'deny',
          resource: `session:${actor.sessionId}`,
          requestId: req.id,
          details: { reason: 'rate limited' },
        });
        throw new ApiError('RATE_LIMITED', 'too many step-up attempts; try later');
      }

      const stored = await deps.pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM api_users WHERE id = $1',
        [actor.user.id]
      );
      const valid = await verifyPassword(body.password, stored.rows[0]!.password_hash);
      if (!valid) {
        recordAttempt(actor.user.id);
        await recordAudit(deps.pool, {
          actorId: actor.user.id,
          action: 'auth.stepup',
          result: 'deny',
          resource: `session:${actor.sessionId}`,
          requestId: req.id,
          details: { reason: 'bad credentials' },
        });
        throw new ApiError('UNAUTHORIZED', 'invalid password');
      }

      await deps.pool.query(
        'UPDATE api_sessions SET step_up_at = now() WHERE id = $1::uuid AND revoked_at IS NULL',
        [actor.sessionId]
      );
      await recordAudit(deps.pool, {
        actorId: actor.user.id,
        action: 'auth.stepup',
        result: 'allow',
        resource: `session:${actor.sessionId}`,
        requestId: req.id,
      });
      return ok({ stepUpGranted: true });
    }
  );

  console.log('[boot] plugin:security exit');
}
