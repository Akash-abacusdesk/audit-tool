import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError, ok, jitRedeemInput, jitRequestInput, jitRevokeInput } from '@platform/shared';
import { requirePermission } from '../auth/service.js';
import { recordAudit } from '../auth/audit.js';
import { withTx } from '../db/pool.js';

interface Deps {
  pool: Pool;
}

/**
 * Just-in-time privileged access lifecycle (S8-D1).
 *   POST /api/v1/jit/requests                  (jit.request)  -> 202 {request_id}
 *   POST /api/v1/jit/requests/:id/approve      (jit.approve)  -> 200 {request_id, token}
 *   POST /api/v1/jit/redeem                    (token, no session) -> 200 {grant_id, ttl_seconds, requester}
 *   POST /api/v1/jit/:grantId/revoke           (jit.revoke)   -> 200 {grant_id, status}
 *
 * The raw opaque token is shown once at approval and stored only as its
 * SHA-256; redemption consumes the token atomically (FOR UPDATE + consumed_at)
 * so a capture cannot be replayed for a second grant.
 */
export async function jitRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.post('/jit/requests', { preHandler: requirePermission('jit.request') }, async (req, reply) => {
    const input = jitRequestInput.parse(req.body);
    const actor = req.actor!;
    const id = randomUUID();
    await deps.pool.query(
      `INSERT INTO jit_requests (id, site_id, reason, duration_minutes, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, now())`,
      [id, input.site_id, input.reason, input.duration_minutes, actor.user.id]
    );
    await recordAudit(deps.pool, {
      actorId: actor.user.id,
      action: 'jit.request',
      result: 'allow',
      resource: `jit:${id}`,
      requestId: req.id,
      details: { site_id: input.site_id, duration_minutes: input.duration_minutes },
    });
    return reply.code(202).send(ok({ request_id: id }));
  });

  app.post(
    '/jit/requests/:requestId/approve',
    { preHandler: requirePermission('jit.approve') },
    async (req, reply) => {
      const requestId = (req.params as { requestId: string }).requestId;
      const actor = req.actor!;

      const r = await deps.pool.query<{ id: string; status: string; duration_minutes: number }>(
        `SELECT id, status, duration_minutes FROM jit_requests WHERE id = $1`,
        [requestId]
      );
      const row = r.rows[0];
      if (!row || row.status !== 'pending') throw new ApiError('NOT_FOUND', 'jit request not pending');

      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const tokenExpires = new Date(Date.now() + row.duration_minutes * 60_000);

      await withTx(deps.pool, async (tx) => {
        await tx.query(
          `INSERT INTO jit_tokens (token_hash, request_id, expires_at) VALUES ($1, $2, $3)
           ON CONFLICT (token_hash) DO UPDATE SET request_id = EXCLUDED.request_id`,
          [tokenHash, requestId, tokenExpires]
        );
        await tx.query(
          `UPDATE jit_requests SET status = 'approved', approved_at = now(), token_issued_at = now(), expires_at = $2 WHERE id = $1`,
          [requestId, tokenExpires]
        );
      });

      await recordAudit(deps.pool, {
        actorId: actor.user.id,
        action: 'jit.approve',
        result: 'allow',
        resource: `jit:${requestId}`,
        requestId: req.id,
        details: {},
      });
      // Token shown exactly once; the caller must relay it to the WP plugin.
      // Surfaced to the requester's UI as `redemption_code` (Angela S8-D5).
      return reply.code(200).send(ok({ request_id: requestId, token, redemption_code: token }));
    }
  );

  app.post(
    '/jit/requests/:requestId/reject',
    { preHandler: requirePermission('jit.approve') },
    async (req, reply) => {
      const requestId = (req.params as { requestId: string }).requestId;
      const actor = req.actor!;
      const r = await deps.pool.query(
        `UPDATE jit_requests SET status = 'rejected', approved_at = now() WHERE id = $1 AND status = 'pending'`,
        [requestId]
      );
      if (r.rowCount === 0) throw new ApiError('NOT_FOUND', 'jit request not pending');
      await recordAudit(deps.pool, {
        actorId: actor.user.id,
        action: 'jit.reject',
        result: 'allow',
        resource: `jit:${requestId}`,
        requestId: req.id,
        details: {},
      });
      return reply.code(200).send(ok({ request_id: requestId, status: 'rejected' }));
    }
  );

  app.post('/jit/redeem', async (req, reply) => {
    const input = jitRedeemInput.parse(req.body);

    // Atomic: lock token, reject if consumed/expired, mark consumed, mint grant.
    const grant = await withTx(deps.pool, async (tx) => {
      const tok = await tx.query<{ request_id: string; consumed_at: Date | null; expires_at: Date }>(
        `SELECT request_id, consumed_at, expires_at FROM jit_tokens WHERE token_hash = $1 FOR UPDATE`,
        [input.token_hash]
      );
      const t = tok.rows[0];
      if (!t) throw new ApiError('NOT_FOUND', 'invalid token');
      if (t.consumed_at) throw new ApiError('CONFLICT', 'token already used');
      if (t.expires_at.getTime() < Date.now()) throw new ApiError('VALIDATION_ERROR', 'token expired');

      const reqRow = await tx.query<{ site_id: string; duration_minutes: number }>(
        `SELECT site_id, duration_minutes FROM jit_requests WHERE id = $1`,
        [t.request_id]
      );
      const rr = reqRow.rows[0];
      if (!rr) throw new ApiError('NOT_FOUND', 'invalid token');

      const grantId = `grant_${randomUUID().slice(0, 8)}`;
      const ttl = rr.duration_minutes * 60;
      const grantExpires = new Date(Date.now() + ttl * 1000);

      await tx.query(
        `UPDATE jit_tokens SET consumed_at = now() WHERE token_hash = $1`,
        [input.token_hash]
      );
      await tx.query(
        `INSERT INTO jit_grants (grant_id, request_id, token_hash, site_id, requester, ttl_seconds, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [grantId, t.request_id, input.token_hash, rr.site_id, input.request_id, ttl, grantExpires]
      );
      return { grantId, ttl, siteId: rr.site_id };
    });

    await recordAudit(deps.pool, {
      actorId: null,
      action: 'jit.redeem',
      result: 'allow',
      resource: `jit:grant/${grant.grantId}`,
      requestId: input.request_id,
      details: { site_id: grant.siteId },
    });
    return reply.code(200).send(
      ok({
        grant_id: grant.grantId,
        ttl_seconds: grant.ttl,
        requester: input.request_id,
        site_id: grant.siteId,
      })
    );
  });

  app.post(
    '/jit/grants/:grantId/revoke',
    { preHandler: requirePermission('jit.revoke') },
    async (req, reply) => {
      const grantId = (req.params as { grantId: string }).grantId;
      const actor = req.actor!;
      const r = await deps.pool.query(
        `UPDATE jit_grants SET status = 'revoked', revoked_at = now() WHERE grant_id = $1 AND status = 'active'`,
        [grantId]
      );
      if (r.rowCount === 0) throw new ApiError('NOT_FOUND', 'grant not active');
      await recordAudit(deps.pool, {
        actorId: actor.user.id,
        action: 'jit.revoke',
        result: 'allow',
        resource: `jit:grant/${grantId}`,
        requestId: req.id,
        details: {},
      });
      return reply.code(200).send(ok({ grant_id: grantId, status: 'revoked' }));
    }
  );

  // List endpoints (S8-D5): prerequisite for a functional approval/grant UI.
  app.get('/jit/requests', { preHandler: requirePermission('jit.request') }, async (req) => {
    const status = (req.query as { status?: string }).status;
    const params: unknown[] = [];
    let sql = `SELECT id, site_id, reason, duration_minutes, status, created_by, created_at, expires_at, approved_at
               FROM jit_requests`;
    if (status) {
      params.push(status);
      sql += ` WHERE status = $1`;
    }
    sql += ` ORDER BY created_at DESC`;
    const r = await deps.pool.query(sql, params);
    return ok(r.rows);
  });

  app.get('/jit/grants', { preHandler: requirePermission('jit.approve') }, async () => {
    const r = await deps.pool.query(
      `SELECT grant_id, ttl_seconds, requester, site_id, status, issued_at, expires_at
       FROM jit_grants ORDER BY issued_at DESC`
    );
    return ok(r.rows);
  });
}
