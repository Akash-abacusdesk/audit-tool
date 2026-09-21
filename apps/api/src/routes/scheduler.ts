import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApiError, ok } from '@platform/shared';
import { recordAudit } from '../auth/audit.js';
import { requirePermission } from '../auth/service.js';
import { demoJobPayload } from '../scheduler/classes.js';
import type { Scheduler } from '../scheduler/scheduler.js';

interface Deps {
  pool: Pool;
  scheduler: Scheduler;
}

const enqueueInput = z.object({
  classKey: z.string().min(1),
  payload: demoJobPayload.default({}),
});

const cancelInput = z.object({
  classKey: z.string().min(1),
  jobId: z.string().uuid(),
});

// ponytail: test-only probe for the restart-survival battery (enqueue -> kill
// -> reboot -> completes). Routes 404 unless SCHED_RESTART_PROBE_TOKEN is set,
// which production boots never do. Payload is forwarded to the scheduler's
// union validation (demo envelope OR scan shape).
const PROBE_TOKEN = process.env.SCHED_RESTART_PROBE_TOKEN ?? '';
const probeInput = z
  .object({ classKey: z.string().min(1).default('standard_pr') })
  .passthrough();

function probeAuthorized(req: { headers: Record<string, unknown> }): void {
  if (!PROBE_TOKEN) throw new ApiError('NOT_FOUND', 'route not found');
  const h = req.headers.authorization;
  if (typeof h !== 'string' || h !== `Bearer ${PROBE_TOKEN}`) {
    throw new ApiError('UNAUTHORIZED', 'missing or invalid probe token');
  }
}

export async function schedulerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get(
    '/scheduler/stats',
    { preHandler: requirePermission('scheduler.read') },
    async () => ok(await deps.scheduler.telemetry())
  );

  app.post(
    '/scheduler/jobs',
    { preHandler: requirePermission('scheduler.manage') },
    async (req, reply) => {
      const parsed = enqueueInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { classKey, payload } = parsed.data;
      if (!deps.scheduler.hasClass(classKey)) {
        throw new ApiError('NOT_FOUND', `unknown workload class: ${classKey}`);
      }
      const jobId = await deps.scheduler.enqueue(classKey, payload);
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'scheduler.enqueue',
        result: 'allow',
        resource: `job:${jobId ?? 'null'}`,
        requestId: req.id,
        details: { classKey },
      });
      return reply.status(201).send(ok({ jobId }));
    }
  );

  app.post(
    '/scheduler/jobs/cancel',
    { preHandler: requirePermission('scheduler.manage') },
    async (req) => {
      const parsed = cancelInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { classKey, jobId } = parsed.data;
      if (!deps.scheduler.hasClass(classKey)) {
        throw new ApiError('NOT_FOUND', `unknown workload class: ${classKey}`);
      }
      await deps.scheduler.cancelJob(classKey, jobId);
      const job = await deps.scheduler.jobStatus(classKey, jobId);
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'scheduler.cancel',
        result: 'allow',
        resource: `job:${jobId}`,
        requestId: req.id,
        details: { classKey, state: job?.state ?? null },
      });
      return ok({ job });
    }
  );

  app.post('/internal/scheduler/probe', async (req, reply) => {
    probeAuthorized(req);
    const parsed = probeInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const { classKey, ...payload } = parsed.data;
    // Payload forwarded untouched — the scheduler's union validation
    // (demo envelope | scan shape) is the single authority.
    const jobId = await deps.scheduler.enqueue(classKey, payload);
    return reply.status(201).send(ok({ jobId }));
  });

  app.get('/internal/scheduler/probe/:classKey/:jobId', async (req) => {
    probeAuthorized(req);
    const { classKey, jobId } = req.params as { classKey: string; jobId: string };
    if (!deps.scheduler.hasClass(classKey)) {
      throw new ApiError('NOT_FOUND', `unknown workload class: ${classKey}`);
    }
    return ok({ job: await deps.scheduler.jobStatus(classKey, jobId) });
  });
}
