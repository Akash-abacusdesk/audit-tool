import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { ApiError, isUuid, ok, UPDATE_EVENTS, type TransitionContext, type UpdateEvent } from '@platform/shared';
import { requirePermission } from '../auth/service.js';
import { recordAudit } from '../auth/audit.js';
import { withTx } from '../db/pool.js';
import { assertProjectScope } from '../auth/scope.js';
import { InMemoryUpdateStore, UpdateOrchestrator, type UpdateStore } from '../update/queue.js';
import { COMPONENT_RE, VERSION_RE } from '../update/production.js';
import { PgUpdateStore } from '../update/pg-store.js';

interface Deps {
  pool: import('pg').Pool;
  boss: PgBoss;
}

/** Durable update-unit store, api_update_units (migration 010). Bound to a real pool on route registration. */
export let updateStore: UpdateStore = new InMemoryUpdateStore();

/**
 * Section-13 Safe WordPress Update Engine HTTP surface (S13-D1).
 *   POST /api/v1/update-units                  (update.manage) -> 201 {id}
 *   POST /api/v1/update-units/:id/transition    (update.manage) -> 202 {state, jobId, queued}
 *   GET  /api/v1/update-units/:id               (update.manage) -> 200 {entry}
 *
 * No direct production update: promotion only reaches `promoting` after the
 * unit has passed staging/functional/visual validation and been approved —
 * the state machine (update-state.ts) refuses any other path.
 */
export async function updateRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:update enter');
  updateStore = new PgUpdateStore(deps.pool);
  const orchestrator = new UpdateOrchestrator(deps.boss, updateStore);

  /** Load the unit and require update.manage at ITS project/environment (not just anywhere). */
  async function assertUnitScope(req: FastifyRequest, id: string, action: string) {
    const entry = await updateStore.get(id);
    if (!entry) throw new ApiError('NOT_FOUND', `update unit ${id} not found`);
    await assertProjectScope(req, entry.projectId, entry.environmentId, action, 'update.manage');
    return entry;
  }

  app.post('/update-units', { preHandler: requirePermission('update.manage') }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      projectId?: string;
      environmentId?: string;
      component?: string;
      fromVersion?: string;
      toVersion?: string;
    };
    if (!body.projectId || !isUuid(body.projectId)) {
      throw new ApiError('VALIDATION_ERROR', 'projectId (uuid) is required');
    }
    if (!body.environmentId || !isUuid(body.environmentId)) {
      throw new ApiError('VALIDATION_ERROR', 'environmentId (uuid) is required');
    }
    // These reach `wp plugin|core update` argv in production.ts: allow-list, never pass a flag through.
    if (typeof body.component !== 'string' || !COMPONENT_RE.test(body.component)) {
      throw new ApiError('VALIDATION_ERROR', "component must be 'core' or a plugin slug ([a-z0-9_-], max 64)");
    }
    if (typeof body.fromVersion !== 'string' || !VERSION_RE.test(body.fromVersion) || typeof body.toVersion !== 'string' || !VERSION_RE.test(body.toVersion)) {
      throw new ApiError('VALIDATION_ERROR', 'fromVersion and toVersion must be plain version strings (e.g. 6.5.2)');
    }
    await assertProjectScope(req, body.projectId, body.environmentId, 'update.create', 'update.manage');
    // Same component/version already in flight for this environment: return a conflict, not a duplicate unit.
    const dup = await deps.pool.query<{ id: string }>(
      `SELECT id::text FROM api_update_units
        WHERE environment_id = $1 AND component = $2 AND to_version = $3 AND state NOT IN ('promoted', 'rollback') LIMIT 1`,
      [body.environmentId, body.component, body.toVersion]
    );
    if (dup.rows[0]) throw new ApiError('CONFLICT', `update unit ${dup.rows[0].id} is already in progress for this component/version`);
    const id = await withTx(deps.pool, async (tx) => {
      const created = await orchestrator.create(body.projectId!, body.environmentId!, body.component!, body.fromVersion!, body.toVersion!, tx);
      await recordAudit(tx, {
        actorId: req.actor!.user.id,
        action: 'update.create',
        result: 'allow',
        projectId: body.projectId,
        environmentId: body.environmentId,
        resource: `update-unit:${created}`,
        requestId: req.id,
        details: { component: body.component, fromVersion: body.fromVersion, toVersion: body.toVersion },
      });
      return created;
    });
    return reply.status(201).send(ok({ id }));
  });

  app.post(
    '/update-units/:id/transition',
    { preHandler: requirePermission('update.manage') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await assertUnitScope(req, id, 'update.transition');
      const body = (req.body ?? {}) as { event?: UpdateEvent } & TransitionContext;
      if (!body.event || !(UPDATE_EVENTS as readonly string[]).includes(body.event)) {
        throw new ApiError('VALIDATION_ERROR', `event must be one of ${UPDATE_EVENTS.join('|')}`);
      }
      // State change + its pg-boss job + the audit event commit together.
      const { state, jobId } = await withTx(deps.pool, async (tx) => {
        const out = await orchestrator.transition(id, body.event!, { stagingReady: body.stagingReady }, tx);
        await recordAudit(tx, {
          actorId: req.actor!.user.id,
          action: `update.${body.event}`,
          result: 'allow',
          resource: `update-unit:${id}`,
          requestId: req.id,
          details: { state: out.state },
        });
        return out;
      });
      return reply.status(202).send(ok({ state, jobId, queued: jobId !== null }));
    }
  );

  app.get('/update-units/:id', { preHandler: requirePermission('update.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const entry = await assertUnitScope(req, id, 'update.read');
    return ok(entry);
  });

  console.log('[boot] plugin:update exit');
}
