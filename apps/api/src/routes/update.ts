import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { ApiError, isUuid, ok, UPDATE_EVENTS, type TransitionContext, type UpdateEvent } from '@platform/shared';
import { requirePermission } from '../auth/service.js';
import { recordAudit } from '../auth/audit.js';
import { InMemoryUpdateStore, UpdateOrchestrator, type UpdateStore } from '../update/queue.js';
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
    if (!body.component || typeof body.component !== 'string') {
      throw new ApiError('VALIDATION_ERROR', 'component (string) is required');
    }
    if (!body.fromVersion || !body.toVersion) {
      throw new ApiError('VALIDATION_ERROR', 'fromVersion and toVersion are required');
    }
    const id = await orchestrator.create(body.projectId, body.environmentId, body.component, body.fromVersion, body.toVersion);
    await recordAudit(deps.pool, {
      actorId: req.actor!.user.id,
      action: 'update.create',
      result: 'allow',
      projectId: body.projectId,
      environmentId: body.environmentId,
      resource: `update-unit:${id}`,
      requestId: req.id,
      details: { component: body.component, fromVersion: body.fromVersion, toVersion: body.toVersion },
    });
    return reply.status(201).send(ok({ id }));
  });

  app.post(
    '/update-units/:id/transition',
    { preHandler: requirePermission('update.manage') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { event?: UpdateEvent } & TransitionContext;
      if (!body.event || !(UPDATE_EVENTS as readonly string[]).includes(body.event)) {
        throw new ApiError('VALIDATION_ERROR', `event must be one of ${UPDATE_EVENTS.join('|')}`);
      }
      const { state, jobId } = await orchestrator.transition(id, body.event, { stagingReady: body.stagingReady });
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: `update.${body.event}`,
        result: 'allow',
        resource: `update-unit:${id}`,
        requestId: req.id,
        details: { state },
      });
      return reply.status(202).send(ok({ state, jobId, queued: jobId !== null }));
    }
  );

  app.get('/update-units/:id', { preHandler: requirePermission('update.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const entry = await updateStore.get(id);
    if (!entry) throw new ApiError('NOT_FOUND', `update unit ${id} not found`);
    return ok(entry);
  });

  console.log('[boot] plugin:update exit');
}
