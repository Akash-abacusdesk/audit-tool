import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ApiError, ok } from '@platform/shared';
import { recordAudit } from '../auth/audit.js';
import { bearerOf, requireAuth, requirePermission, resolveActor } from '../auth/service.js';
import { verifyPassword } from '../auth/passwords.js';
import {
  assertFreshStepUp,
  assertManagementNetwork,
  assertSpoolHasRoom,
  isAdminUrl,
} from '../auth/privileged.js';
import { getLockdownStatus, setLockdown } from '../security/lockdown.js';
import { createLimiter } from '../util/rate-limit.js';
import { beginEnrollment, confirmEnrollment, disableMfa, isMfaActive, verifySecondFactor } from '../auth/mfa.js';
import { otpauthUri } from '../auth/totp.js';

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

const stepUpLimiter = createLimiter(
  Number(process.env.ADMIN_STEPUP_MAX_ATTEMPTS ?? 5),
  Number(process.env.ADMIN_STEPUP_WINDOW_MIN ?? 15) * 60_000
);
const rateLimited = stepUpLimiter.blocked;
const recordAttempt = stepUpLimiter.record;

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

      // Second factor: required once a TOTP factor is confirmed (or when ADMIN_REQUIRE_MFA=true, which refuses
      // step-up until the user has enrolled). Failures count against the same limiter as bad passwords.
      const mfaActive = await isMfaActive(deps.pool, actor.user.id);
      if (mfaActive) {
        const b = body as { code?: unknown; recoveryCode?: unknown };
        if (!(await verifySecondFactor(deps.pool, actor.user.id, b))) {
          recordAttempt(actor.user.id);
          await recordAudit(deps.pool, {
            actorId: actor.user.id,
            action: 'auth.stepup',
            result: 'deny',
            resource: `session:${actor.sessionId}`,
            requestId: req.id,
            details: { reason: 'bad second factor' },
          });
          throw new ApiError('UNAUTHORIZED', 'a valid authenticator code (or recovery code) is required');
        }
      } else if (process.env.ADMIN_REQUIRE_MFA === 'true') {
        throw new ApiError('FORBIDDEN', 'MFA enrollment is required: POST /auth/mfa/enroll');
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

  // ---- TOTP enrollment (authenticator app). A password re-check guards each change. ----

  async function assertPassword(req: import('fastify').FastifyRequest, password: unknown): Promise<void> {
    const actor = req.actor!;
    if (typeof password !== 'string' || !password) throw new ApiError('VALIDATION_ERROR', 'password is required');
    if (rateLimited(actor.user.id)) throw new ApiError('RATE_LIMITED', 'too many attempts; try later');
    const stored = await deps.pool.query<{ password_hash: string }>('SELECT password_hash FROM api_users WHERE id = $1', [actor.user.id]);
    if (!(await verifyPassword(password, stored.rows[0]!.password_hash))) {
      recordAttempt(actor.user.id);
      throw new ApiError('UNAUTHORIZED', 'invalid password');
    }
  }

  app.post('/auth/mfa/enroll', { preHandler: [assertManagementNetwork, requireAuth] }, async (req) => {
    await assertPassword(req, (req.body as { password?: unknown } | null)?.password);
    const actor = req.actor!;
    const secret = await beginEnrollment(deps.pool, actor.user.id);
    if (!secret) throw new ApiError('CONFLICT', 'MFA is already active; disable it first');
    await recordAudit(deps.pool, { actorId: actor.user.id, action: 'auth.mfa.enroll', result: 'allow', resource: `user:${actor.user.id}`, requestId: req.id });
    return ok({ secret, otpauthUri: otpauthUri(secret, actor.user.email) });
  });

  app.post('/auth/mfa/confirm', { preHandler: [assertManagementNetwork, requireAuth] }, async (req) => {
    const actor = req.actor!;
    if (rateLimited(actor.user.id)) throw new ApiError('RATE_LIMITED', 'too many attempts; try later');
    const codes = await confirmEnrollment(deps.pool, actor.user.id, String((req.body as { code?: unknown } | null)?.code ?? ''));
    if (!codes) {
      recordAttempt(actor.user.id);
      throw new ApiError('UNAUTHORIZED', 'invalid code');
    }
    await recordAudit(deps.pool, { actorId: actor.user.id, action: 'auth.mfa.confirm', result: 'allow', resource: `user:${actor.user.id}`, requestId: req.id });
    return ok({ enabled: true, recoveryCodes: codes }); // shown once
  });

  app.post('/auth/mfa/disable', { preHandler: [assertManagementNetwork, requireAuth] }, async (req) => {
    const actor = req.actor!;
    const b = (req.body ?? {}) as { password?: unknown; code?: unknown; recoveryCode?: unknown };
    await assertPassword(req, b.password);
    if (await isMfaActive(deps.pool, actor.user.id)) {
      if (!(await verifySecondFactor(deps.pool, actor.user.id, b))) {
        recordAttempt(actor.user.id);
        throw new ApiError('UNAUTHORIZED', 'a valid authenticator code (or recovery code) is required');
      }
    }
    await disableMfa(deps.pool, actor.user.id);
    await recordAudit(deps.pool, { actorId: actor.user.id, action: 'auth.mfa.disable', result: 'allow', resource: `user:${actor.user.id}`, requestId: req.id });
    return ok({ enabled: false });
  });

  /**
   * S16 runbook action 5: emergency lockdown toggle. Under the admin-plane
   * gate (management-network + fresh step-up, via adminGate()/ADMIN_URL_PREFIXES)
   * AND requires `platform.lockdown` (security_admin only — not manager,
   * deliberate separation of duties). Blocks prod.execute/update.manage/
   * jit.approve/finding.remediate platform-wide the instant it's enabled;
   * JIT revoke and all reads stay open throughout.
   */
  app.get('/security/lockdown', { preHandler: requirePermission('platform.lockdown') }, async () => {
    return ok(await getLockdownStatus(deps.pool));
  });

  app.post('/security/lockdown', { preHandler: requirePermission('platform.lockdown') }, async (req) => {
    const body = (req.body ?? {}) as { enabled?: unknown; reason?: unknown };
    if (typeof body.enabled !== 'boolean') {
      throw new ApiError('VALIDATION_ERROR', 'enabled (boolean) is required');
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const actor = req.actor!;
    const status = await setLockdown(deps.pool, body.enabled, actor.user.id, reason);
    await recordAudit(deps.pool, {
      actorId: actor.user.id,
      action: body.enabled ? 'platform.lockdown.enable' : 'platform.lockdown.disable',
      result: 'allow',
      resource: 'platform:lockdown',
      requestId: req.id,
      details: { reason: reason ?? null },
    });
    return ok(status);
  });

  console.log('[boot] plugin:security exit');
}
