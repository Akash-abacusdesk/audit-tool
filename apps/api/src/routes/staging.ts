import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { ApiError, isUuid, ok, type StagingSafetyContext } from '@platform/shared';
import { requirePermission } from '../auth/service.js';
import { recordAudit } from '../auth/audit.js';
import { withTx } from '../db/pool.js';
import { assertProjectScope } from '../auth/scope.js';
import { InMemoryStagingStore, StagingOrchestrator, type StagingStore } from '../staging/queue.js';
import { PgStagingStore } from '../staging/pg-store.js';

interface Deps {
  pool: import('pg').Pool;
  boss: PgBoss;
}

/** Durable staging run store, api_staging_runs (migration 009). Bound to a real pool on route registration. */
export let stagingStore: StagingStore = new InMemoryStagingStore();

/**
 * Section-11 Safe Staging HTTP surface (S11-D1).
 *   POST /api/v1/staging                    (staging.manage) -> 202 {stagingId, jobId}
 *   POST /api/v1/staging/:id/test-run        (staging.manage) -> 202 {jobId} — safety-gated
 *   POST /api/v1/staging/:id/destroy         (staging.manage) -> 202 {jobId}
 *   GET  /api/v1/staging/:id                 (staging.manage) -> 200 {stagingId, state}
 */
export async function stagingRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:staging enter');
  stagingStore = new PgStagingStore(deps.pool);
  const orchestrator = new StagingOrchestrator(deps.boss, stagingStore);

  /** Load the run and require staging.manage at ITS project/environment (not just anywhere). */
  async function assertStagingScope(req: FastifyRequest, id: string, action: string) {
    const entry = await stagingStore.get(id);
    if (!entry) throw new ApiError('NOT_FOUND', `staging ${id} not found`);
    await assertProjectScope(req, entry.projectId, entry.environmentId, action, 'staging.manage');
    return entry;
  }

  app.post('/staging', { preHandler: requirePermission('staging.manage') }, async (req, reply) => {
    const body = (req.body ?? {}) as { projectId?: string; environmentId?: string; ref?: string };
    if (!body.projectId || !isUuid(body.projectId)) {
      throw new ApiError('VALIDATION_ERROR', 'projectId (uuid) is required');
    }
    if (!body.environmentId || !isUuid(body.environmentId)) {
      throw new ApiError('VALIDATION_ERROR', 'environmentId (uuid) is required');
    }
    if (!body.ref || typeof body.ref !== 'string') {
      throw new ApiError('VALIDATION_ERROR', 'ref (string) is required');
    }
    await assertProjectScope(req, body.projectId, body.environmentId, 'staging.provision', 'staging.manage');
    // A double-click (or retry) must not stand up a second environment: one live staging per environment.
    const live = await deps.pool.query<{ id: string }>(
      `SELECT id::text FROM api_staging_runs
        WHERE environment_id = $1 AND state IN ('requested', 'provisioning', 'ready', 'destroying') LIMIT 1`,
      [body.environmentId]
    );
    if (live.rows[0]) throw new ApiError('CONFLICT', `environment already has an active staging run (${live.rows[0].id})`);
    // Run row + state change + pg-boss job + audit event commit as one unit (nothing to strand on a crash).
    const { stagingId, jobId } = await withTx(deps.pool, async (tx) => {
      const out = await orchestrator.provision(body.projectId!, body.environmentId!, body.ref!, tx);
      await recordAudit(tx, {
        actorId: req.actor!.user.id,
        action: 'staging.provision',
        result: 'allow',
        projectId: body.projectId,
        environmentId: body.environmentId,
        resource: `staging:${out.stagingId}`,
        requestId: req.id,
        details: { ref: body.ref },
      });
      return out;
    });
    return reply.status(202).send(ok({ stagingId, jobId, queued: true }));
  });

  app.post(
    '/staging/:id/test-run',
    { preHandler: requirePermission('staging.manage') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await assertStagingScope(req, id, 'staging.test_run');
      const body = (req.body ?? {}) as { suite?: 'smoke' | 'functional' | 'visual' } & Partial<StagingSafetyContext>;
      if (!body.suite || !['smoke', 'functional', 'visual'].includes(body.suite)) {
        throw new ApiError('VALIDATION_ERROR', 'suite must be one of smoke|functional|visual');
      }
      const safety: StagingSafetyContext = {
        piiSanitized: body.piiSanitized === true,
        integrationsNeutralized: body.integrationsNeutralized === true,
        noindexEnabled: body.noindexEnabled === true,
      };
      const { jobId } = await orchestrator.requestTestRun(id, body.suite, safety);
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'staging.test_run',
        result: 'allow',
        resource: `staging:${id}`,
        requestId: req.id,
        details: { suite: body.suite },
      });
      return reply.status(202).send(ok({ jobId, queued: true }));
    }
  );

  app.post(
    '/staging/:id/destroy',
    { preHandler: requirePermission('staging.manage') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await assertStagingScope(req, id, 'staging.destroy');
      const { jobId } = await withTx(deps.pool, async (tx) => {
        const out = await orchestrator.destroy(id, tx);
        await recordAudit(tx, {
          actorId: req.actor!.user.id,
          action: 'staging.destroy',
          result: 'allow',
          resource: `staging:${id}`,
          requestId: req.id,
          details: {},
        });
        return out;
      });
      return reply.status(202).send(ok({ jobId, queued: true }));
    }
  );

  app.get('/staging/:id', { preHandler: requirePermission('staging.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const entry = await assertStagingScope(req, id, 'staging.read');
    return ok(entry);
  });

  console.log('[boot] plugin:staging exit');
}
