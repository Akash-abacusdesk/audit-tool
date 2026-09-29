import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  ApiError,
  bootstrapInput,
  loginInput,
  ok,
  passwordChangeInput,
  type MeResponse,
  type RoleBindingDto,
  type SessionDto,
  type UserDto,
} from '@platform/shared';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../auth/passwords.js';
import { recordAudit } from '../auth/audit.js';
import { bearerOf, createSession, requireAuth, revokeSessionByToken } from '../auth/service.js';
import { withTx } from '../db/pool.js';
import { createSharedLimiter } from '../util/rate-limit-pg.js';

interface Deps {
  pool: Pool;
}

export function toUserDto(r: {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  created_at: Date;
}): UserDto {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    isActive: r.is_active,
    createdAt: r.created_at.toISOString(),
  };
}

export function toBindingDto(r: {
  id: string;
  user_id: string;
  role: RoleBindingDto['role'];
  org_id: string;
  project_id: string | null;
  environment_id: string | null;
  created_at: Date;
}): RoleBindingDto {
  return {
    id: r.id,
    userId: r.user_id,
    role: r.role,
    orgId: r.org_id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    createdAt: r.created_at.toISOString(),
  };
}

const BINDING_SELECT = `SELECT id::text, user_id::text, role, org_id::text, project_id::text,
        environment_id::text, created_at FROM api_role_bindings`;

export async function authRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:auth enter');
  // Shared across replicas (Postgres), so brute force can't be spread over API instances.
  const loginLimiter = createSharedLimiter(
    deps.pool,
    Number(process.env.LOGIN_MAX_FAILURES ?? 10),
    Number(process.env.LOGIN_WINDOW_MIN ?? 15) * 60_000
  );
  /**
   * One-time bootstrap — creates the first user + org while zero users exist.
   * The first account holds BOTH manager and security_admin to break the
   * chicken-and-egg on user administration; tighten roles afterwards.
   */
  app.post('/auth/bootstrap', async (req, reply) => {
    const parsed = bootstrapInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const { email, password, displayName, orgName, orgSlug } = parsed.data;

    // Optional shared secret: when set, only the operator who knows it can claim the first account.
    const expected = process.env.BOOTSTRAP_TOKEN;
    if (expected) {
      const given = Buffer.from(String(req.headers['x-bootstrap-token'] ?? ''));
      const want = Buffer.from(expected);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new ApiError('FORBIDDEN', 'bootstrap token required');
    }

    const session = await withTx(deps.pool, async (tx) => {
      // Serialize concurrent bootstraps and re-check inside the lock: two racing callers must not both win.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('api.bootstrap'))");
      const count = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM api_users');
      if (count.rows[0]!.n !== '0') {
        throw new ApiError('CONFLICT', 'bootstrap already done — users exist');
      }
      const passwordHash = await hashPassword(password);
      const user = await tx.query<{ id: string }>(
        `INSERT INTO api_users (email, display_name, password_hash) VALUES ($1, $2, $3)
         RETURNING id::text`,
        [email.toLowerCase(), displayName, passwordHash]
      );
      const userId = user.rows[0]!.id;
      const org = await tx.query<{ id: string }>(
        'INSERT INTO api_orgs (name, slug) VALUES ($1, $2) RETURNING id::text',
        [orgName, orgSlug]
      );
      const orgId = org.rows[0]!.id;
      for (const role of ['manager', 'security_admin'] as const) {
        await tx.query(`INSERT INTO api_role_bindings (user_id, role, org_id) VALUES ($1, $2, $3)`, [
          userId,
          role,
          orgId,
        ]);
      }
      return createSession(tx, userId);
    });

    req.log.info({ route: 'POST /api/v1/auth/bootstrap' }, 'bootstrap completed');
    return reply.status(201).send(ok(session));
  });

  app.post('/auth/login', async (req) => {
    const parsed = loginInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const email = parsed.data.email.toLowerCase();

    // Failed-login throttle per account and per source address; blocks before any scrypt work.
    const keys = [`email:${email}`, `ip:${req.ip}`];
    for (const k of keys) {
      if (await loginLimiter.blocked(k)) throw new ApiError('RATE_LIMITED', 'too many failed logins; try later');
    }

    const found = await deps.pool.query<{
      id: string;
      display_name: string;
      created_at: Date;
      password_hash: string;
      is_active: boolean;
    }>(
      'SELECT id::text, display_name, created_at, password_hash, is_active FROM api_users WHERE email = $1',
      [email]
    );
    const row = found.rows[0];
    // Same generic answer for unknown email, wrong password, inactive account.
    let valid = false;
    if (row && row.is_active) valid = await verifyPassword(parsed.data.password, row.password_hash);
    else await burnPasswordCheck(parsed.data.password);
    if (!valid || !row) {
      for (const k of keys) await loginLimiter.record(k);
      await recordAudit(deps.pool, {
        actorId: row?.id ?? null,
        action: 'auth.login',
        result: 'deny',
        resource: `user:${email}`,
        requestId: req.id,
        details: { reason: 'bad credentials' },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid email or password');
    }

    const session = await createSession(deps.pool, row.id);
    await recordAudit(deps.pool, {
      actorId: row.id,
      action: 'auth.login',
      result: 'allow',
      resource: `user:${row.id}`,
      requestId: req.id,
    });
    const dto: SessionDto = {
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      user: {
        id: row.id,
        email,
        displayName: row.display_name,
        isActive: true,
        createdAt: row.created_at.toISOString(),
      },
    };
    return ok(dto);
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req) => {
    const revoked = await revokeSessionByToken(deps.pool, bearerOf(req)!);
    await recordAudit(deps.pool, {
      actorId: req.actor!.user.id,
      action: 'auth.logout',
      result: revoked ? 'allow' : 'error',
      resource: `session:${req.actor!.sessionId}`,
      requestId: req.id,
    });
    return ok({ loggedOut: true });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const bindings = await deps.pool.query<Parameters<typeof toBindingDto>[0]>(
      `${BINDING_SELECT} WHERE user_id = $1 ORDER BY created_at`,
      [req.actor!.user.id]
    );
    const dto: MeResponse = { user: req.actor!.user, bindings: bindings.rows.map(toBindingDto) };
    return ok(dto);
  });

  app.post('/auth/change-password', { preHandler: requireAuth }, async (req) => {
    const parsed = passwordChangeInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const actor = req.actor!;
    const stored = await deps.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM api_users WHERE id = $1',
      [actor.user.id]
    );
    const currentOk = await verifyPassword(
      parsed.data.currentPassword,
      stored.rows[0]!.password_hash
    );
    if (!currentOk) {
      await recordAudit(deps.pool, {
        actorId: actor.user.id,
        action: 'user.password_change',
        result: 'deny',
        resource: `user:${actor.user.id}`,
        requestId: req.id,
        details: { reason: 'current password mismatch' },
      });
      throw new ApiError('UNAUTHORIZED', 'current password is incorrect');
    }
    const newHash = await hashPassword(parsed.data.newPassword);
    await withTx(deps.pool, async (tx) => {
      await tx.query('UPDATE api_users SET password_hash = $2 WHERE id = $1', [
        actor.user.id,
        newHash,
      ]);
      // Every other session dies; the current one survives.
      await tx.query(
        `UPDATE api_sessions SET revoked_at = now()
         WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [actor.user.id, actor.sessionId]
      );
      await recordAudit(tx, {
        actorId: actor.user.id,
        action: 'user.password_change',
        result: 'allow',
        resource: `user:${actor.user.id}`,
        requestId: req.id,
      });
    });
    return ok({ changed: true });
  });
}
