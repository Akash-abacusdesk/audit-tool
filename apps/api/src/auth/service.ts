import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  ApiError,
  permissionsFor,
  type Permission,
  type RoleBindingView,
  type UserDto,
} from '@platform/shared';
import { recordAudit } from './audit.js';
import { isLockedDown, LOCKDOWN_BLOCKED_PERMISSIONS } from '../security/lockdown.js';

const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_HOURS ?? 24) * 3600_000;

export interface Actor {
  user: UserDto;
  sessionId: string;
  bindings: RoleBindingView[];
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
  interface FastifyInstance {
    pool: Pool;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Pick<Pool, 'query'>,
  userId: string
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO api_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), expiresAt]
  );
  return { token, expiresAt };
}

export async function revokeSessionByToken(pool: Pool, token: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE api_sessions SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)]
  );
  return (res.rowCount ?? 0) > 0;
}

interface SessionRow extends UserDtoRaw {
  session_id: string;
}
interface UserDtoRaw {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  created_at: Date;
}

async function loadBindings(db: Pick<Pool, 'query'>, userId: string): Promise<RoleBindingView[]> {
  const res = await db.query<{
    role: RoleBindingView['role'];
    org_id: string;
    project_id: string | null;
    environment_id: string | null;
  }>(
    `SELECT role, org_id::text, project_id::text, environment_id::text
     FROM api_role_bindings WHERE user_id = $1`,
    [userId]
  );
  return res.rows.map((r) => ({
    role: r.role,
    orgId: r.org_id,
    projectId: r.project_id,
    environmentId: r.environment_id,
  }));
}

/** Resolve a bearer token to an active actor, or null. One round trip: the session, user and role bindings together. */
export async function resolveActor(
  db: Pick<Pool, 'query'>,
  token: string
): Promise<Actor | null> {
  const res = await db.query<SessionRow & { bindings?: { role: RoleBindingView['role']; orgId: string; projectId: string | null; environmentId: string | null }[] | null }>(
    `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.is_active, u.created_at,
            (SELECT COALESCE(json_agg(json_build_object(
                      'role', b.role, 'orgId', b.org_id::text,
                      'projectId', b.project_id::text, 'environmentId', b.environment_id::text)), '[]'::json)
               FROM api_role_bindings b WHERE b.user_id = u.id) AS bindings
     FROM api_sessions s JOIN api_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)]
  );
  const row = res.rows[0];
  if (!row || !row.is_active) return null;
  return {
    sessionId: row.session_id,
    // Rows without the aggregated column (an older query shape / a test double) fall back to the separate lookup.
    bindings: row.bindings ?? (await loadBindings(db, row.id)),
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
    },
  };
}

export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  const token = h.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Authentication only — no permission check. Use for endpoints any active
 * session may call (logout, /me).
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearerOf(req);
  const actor = token ? await resolveActor(req.server.pool, token) : null;
  if (!actor) throw new ApiError('UNAUTHORIZED', 'missing or invalid session');
  req.actor = actor;
}

/**
 * Authorization middleware — default deny. Authenticates the bearer token,
 * then requires `perm` to be granted by ANY binding (coarse gate); handlers
 * doing scoped work re-check the exact scope via assertScope(). Denials are
 * audited here so every privileged route leaves a trail.
 */
export function requirePermission(perm: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await requireAuth(req, _reply);
    const actor = req.actor!;

    // Coarse gate: union over all scopes of the actor's bindings.
    const unions = new Set<Permission>();
    for (const b of actor.bindings) {
      for (const p of permissionsFor(actor.bindings, b)) unions.add(p);
    }
    if (!unions.has(perm)) {
      await recordAudit(req.server.pool, {
        actorId: actor.user.id,
        action: `authz.deny.${perm}`,
        result: 'deny',
        resource: `${req.method} ${req.url}`,
        requestId: req.id,
        details: { permission: perm },
      });
      throw new ApiError('FORBIDDEN', `missing permission: ${perm}`);
    }

    // S16 emergency lockdown (compromise-response runbook action 5): a
    // subset of permissions is blocked platform-wide regardless of RBAC,
    // checked fresh (no cache) so a toggle takes effect on the very next
    // request. JIT revoke/read/audit permissions are never in this set —
    // an incident response needs those to still work.
    if (LOCKDOWN_BLOCKED_PERMISSIONS.has(perm) && (await isLockedDown(req.server.pool))) {
      await recordAudit(req.server.pool, {
        actorId: actor.user.id,
        action: `authz.deny.lockdown.${perm}`,
        result: 'deny',
        resource: `${req.method} ${req.url}`,
        requestId: req.id,
        details: { permission: perm },
      });
      throw new ApiError('FORBIDDEN', 'platform is in emergency lockdown');
    }
  };
}

/**
 * Scoped re-check inside handlers: the actor must hold `perm` exactly at
 * `target`. Throws FORBIDDEN (audited) on failure — default-deny.
 */
export async function assertScope(
  req: FastifyRequest,
  target: { orgId: string; projectId?: string | null; environmentId?: string | null },
  action: string,
  perm: Permission
): Promise<void> {
  const actor = req.actor!;
  if (!permissionsFor(actor.bindings, target).has(perm)) {
    await recordAudit(req.server.pool, {
      actorId: actor.user.id,
      action: `authz.deny.${perm}`,
      result: 'deny',
      orgId: target.orgId,
      projectId: target.projectId ?? null,
      environmentId: target.environmentId ?? null,
      resource: action,
      requestId: req.id,
    });
    throw new ApiError('FORBIDDEN', `permission ${perm} not granted for this scope`);
  }
}

/** No-self-approval / separation-of-duties guard for self-targeting writes. */
export async function assertNotSelf(req: FastifyRequest, targetUserId: string, action: string): Promise<void> {
  if (req.actor!.user.id === targetUserId) {
    // S2VAL-3a/3b: every denial must emit an audit event
    // (docs/security/privileged-admin-auth.md section 2).
    await recordAudit(req.server.pool, {
      actorId: req.actor!.user.id,
      action: `authz.deny.${action}`,
      result: 'deny',
      resource: `${req.method} ${req.url}`,
      requestId: req.id,
      details: { selfTarget: targetUserId },
    });
    throw new ApiError('FORBIDDEN', `${action}: acting on your own account is not allowed`);
  }
}
