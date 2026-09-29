import type { FastifyInstance } from 'fastify';
import { ApiError, isUuid, ok } from '@platform/shared';
import { requirePermission } from '../auth/service.js';
import { recordAudit } from '../auth/audit.js';
import { assertProjectScope } from '../auth/scope.js';
import { InMemoryRemediationStore, type RemediationStore } from '../ai-remediation/store.js';
import { PgRemediationStore } from '../ai-remediation/pg-store.js';
import { withTx } from '../db/pool.js';
import type { Scheduler } from '../scheduler/scheduler.js';

interface Deps {
  pool: import('pg').Pool;
  scheduler?: Scheduler;
  /** Shared instance if the caller already built one (main.ts also hands this to Scheduler so job completion writes land in the same store the route reads from). */
  remediationStore?: RemediationStore;
}

/** Durable remediation-request store, api_ai_remediation_requests (migration 011). Bound to a real pool (or the shared instance passed via deps) on route registration. */
export let remediationStore: RemediationStore = new InMemoryRemediationStore();

/**
 * Section-20 developer-triggered AI remediation HTTP surface (S20-D1).
 *   POST /api/v1/findings/:findingId/remediate  (finding.remediate) -> 202 {requestId, queued}
 *   GET  /api/v1/remediation-requests/:id       (finding.remediate) -> 200 {entry}
 *
 * Human-triggered and finding-scoped only (PRD §8.4) — never autonomous.
 * `scheduler.enqueue('ai_remediation', ...)` throws when the class is
 * disabled (the default — SCHED_AI_REMEDIATION_DISABLED flips it on), so an
 * unconfigured deployment refuses closed with a clear error, not a silent drop.
 */
export async function remediationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:remediation enter');
  remediationStore = deps.remediationStore ?? new PgRemediationStore(deps.pool);

  app.post(
    '/findings/:findingId/remediate',
    { preHandler: requirePermission('finding.remediate') },
    async (req, reply) => {
      const { findingId } = req.params as { findingId: string };
      if (!isUuid(findingId)) throw new ApiError('VALIDATION_ERROR', 'findingId must be a uuid');
      const body = (req.body ?? {}) as {
        projectId?: string;
        environmentId?: string;
        findingSummary?: string;
        codeContext?: string;
        stackMetadata?: string;
        projectPolicy?: string;
      };
      if (!body.projectId || !isUuid(body.projectId)) {
        throw new ApiError('VALIDATION_ERROR', 'projectId (uuid) is required');
      }
      if (!body.findingSummary || !body.codeContext) {
        throw new ApiError('VALIDATION_ERROR', 'findingSummary and codeContext are required');
      }
      if (!deps.scheduler) throw new ApiError('UNAVAILABLE', 'scheduler not available');
      await assertProjectScope(req, body.projectId, body.environmentId ?? null, 'remediation.request', 'finding.remediate');

      // Request row + job + audit commit together; a disabled class rolls the row back instead of orphaning it.
      const scheduler = deps.scheduler;
      const { requestId, jobId } = await withTx(deps.pool, async (tx) => {
        const rid = await remediationStore.create(findingId, body.projectId!, body.environmentId ?? null, req.actor!.user.id, tx);
        const jid = await scheduler.enqueue(
          'ai_remediation',
          {
            kind: 'ai_remediation',
            requestId: rid,
            findingId,
            findingSummary: body.findingSummary,
            codeContext: body.codeContext,
            stackMetadata: body.stackMetadata,
            projectPolicy: body.projectPolicy,
          },
          tx
        );
        await recordAudit(tx, {
          actorId: req.actor!.user.id,
          action: 'remediation.request',
          result: 'allow',
          projectId: body.projectId,
          environmentId: body.environmentId,
          resource: `finding:${findingId}`,
          requestId: req.id,
          details: { remediationRequestId: rid },
        });
        return { requestId: rid, jobId: jid };
      });

      return reply.status(202).send(ok({ requestId, jobId, queued: true }));
    }
  );

  app.get(
    '/remediation-requests/:id',
    { preHandler: requirePermission('finding.remediate') },
    async (req) => {
      const { id } = req.params as { id: string };
      const entry = await remediationStore.get(id);
      if (!entry) throw new ApiError('NOT_FOUND', `remediation request ${id} not found`);
      await assertProjectScope(req, entry.projectId, entry.environmentId, 'remediation.read', 'finding.remediate');
      return ok(entry);
    }
  );

  console.log('[boot] plugin:remediation exit');
}
