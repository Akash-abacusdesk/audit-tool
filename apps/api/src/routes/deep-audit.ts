import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  ApiError,
  deepAuditTarget,
  isProductionTarget,
  ok,
  type DeepAuditTarget,
} from '@platform/shared';
import { recordAudit } from '../auth/audit.js';
import { requirePermission } from '../auth/service.js';
import { DeepAuditQueue, DeepAuditStore } from '../deep-audit/queue.js';

interface Deps {
  pool: import('pg').Pool;
  boss: PgBoss;
}

/** Shared in-memory run store (D1). Swap for PG when promoted past CI mocks. */
export const deepAuditStore = new DeepAuditStore();

export async function deepAuditRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:deep-audit enter');

  // ---- Enqueue the serialized 7-stage pipeline (refuses production) ----
  app.post(
    '/deep-audit/run',
    { preHandler: requirePermission('audit.deep') },
    async (req, reply) => {
      const parsed = deepAuditTarget.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid deep-audit target', parsed.error.flatten());
      }
      const target = parsed.data as DeepAuditTarget;
      // Hard gate: no deep-audit step may touch a live production host.
      if (isProductionTarget(target)) {
        throw new ApiError('VALIDATION_ERROR', 'deep-audit may not target a production environment');
      }

      const auditId = deepAuditStore.create(target);
      const queue = new DeepAuditQueue(deps.boss);
      const jobIds = await queue.enqueuePipeline(auditId, target);

      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'audit.deep.enqueue',
        result: 'allow',
        projectId: target.projectId,
        environmentId: target.environmentId,
        resource: `deep-audit:${auditId}`,
        requestId: req.id,
        details: { stages: jobIds.length, environment: target.environment },
      });

      return reply.status(202).send(
        ok({ auditId, stages: jobIds.length, environment: target.environment, queued: true })
      );
    }
  );

  // ---- Fetch the aggregated report for a run ----
  app.get(
    '/deep-audit/:id',
    { preHandler: requirePermission('audit.deep') },
    async (req) => {
      const { id } = req.params as { id: string };
      const entry = deepAuditStore.get(id);
      if (!entry) throw new ApiError('NOT_FOUND', `deep-audit run ${id} not found`);
      if (!entry.report) return ok({ auditId: id, status: 'queued' });
      return ok(entry.report);
    }
  );

  console.log('[boot] plugin:deep-audit exit');
}
