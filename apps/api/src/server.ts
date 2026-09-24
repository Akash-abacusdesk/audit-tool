import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { ApiError, fail, toApiError } from '@platform/shared';
import { healthRoutes } from './routes/health.js';
import { exampleRoutes } from './routes/examples.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { adminGate, securityRoutes } from './routes/security.js';
import { gitRoutes } from './routes/git.js';
import { webhookRoutes } from './routes/webhooks.js';
import { scanningRoutes } from './routes/scanning.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { prodRoutes } from './routes/prod.js';
import { wpEventRoutes } from './routes/wp.js';
import { jitRoutes } from './routes/jit.js';
import { telegramRoutes } from './routes/telegram.js';
import { secretsRoutes } from './routes/secrets.js';
import { deepAuditRoutes } from './routes/deep-audit.js';
import { stagingRoutes } from './routes/staging.js';
import { updateRoutes } from './routes/update.js';
import { remediationRoutes } from './routes/remediation.js';
import type { Scheduler } from './scheduler/scheduler.js';
import type { RemediationStore } from './ai-remediation/store.js';

export interface AppDeps {
  pool: Pool;
  boss: PgBoss;
  bossStarted: boolean;
  /** S4A scheduler; absent in minimal boots (old tests) — routes skip then. */
  scheduler?: Scheduler;
  /** S20 shared instance — main.ts also hands this to Scheduler so job completion writes land where the route reads. */
  remediationStore?: RemediationStore;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const bt0 = Date.now();
  const bt = (n: string): void => console.log(`[boot] buildApp:${n} +${Date.now() - bt0}ms`);
  const app = Fastify({
    // Structured logging per docs/ops/logging.md: ISO-8601 `ts` + `svc` base
    // field on every line; requestId joins via req.id. Zero new deps (pino).
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { svc: 'api' },
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    },
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && h.length > 0 ? h : randomUUID();
    },
  });

  bt('fastify constructed');
  app.decorate('pool', deps.pool);

  // pg emits 'error' on the pool when an IDLE client's connection dies (db
  // restart, bouncer bounce, network blip). Unhandled, that event hard-crashes
  // the process (observed live during merge-wave proof: compose down under a
  // booted API => 'Connection terminated unexpectedly' => exit). Log and let
  // pg discard the dead client; in-flight queries already reject on their own.
  deps.pool.on('error', (err) => {
    app.log.error({ err }, 'pg pool idle client error - connection lost, pg will recover');
  });

  // Echo the correlation id on every response (docs/api-conventions.md).
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Single error funnel — routes throw ApiError, clients only ever see the envelope.
  app.setErrorHandler((err, req, reply) => {
    const apiErr = toApiError(err);
    if (!(err instanceof ApiError)) {
      req.log.error(err, 'unhandled error');
    }
    if (apiErr.status >= 500) req.log.error({ err: apiErr }, 'request failed');
    else req.log.info({ code: apiErr.code }, 'request rejected');
    reply.status(apiErr.status).send(fail(apiErr.code, apiErr.message, apiErr.details, req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .send(fail('NOT_FOUND', `route ${req.method} ${req.url} not found`, undefined, req.id));
  });

  bt('hooks set');
  await app.register(healthRoutes, deps);
  bt('register:health done');
  await app.register(exampleRoutes, { prefix: '/api/v1', ...deps });
  bt('register:examples done');
  await app.register(authRoutes, { prefix: '/api/v1', ...deps });
  bt('register:auth done');
  // S2-D2 (pam): privileged-admin gate on the ROOT scope so it covers adminRoutes
  // (register() encapsulation would otherwise hide it from sibling plugins),
  // then the additive step-up endpoint.
  await adminGate(app, deps);
  await app.register(adminRoutes, { prefix: '/api/v1', ...deps });
  bt('register:admin done');
  await app.register(securityRoutes, { prefix: '/api/v1', ...deps });
  bt('register:security done');
  // S3-D1: git plane (connections/repo links/stack detections/policy
  // assignments). Webhook HTTP ingest deliberately absent — pam's S3-D2
  // signed ingress owns that boundary; table + JOB contract already exist.
  await app.register(gitRoutes, { prefix: '/api/v1', ...deps });
  bt('register:git done');
  // S3-D2 (pam): signed webhook ingress lives OUTSIDE the /api/v1 auth plane —
  // the HMAC signature IS the credential (docs/security/webhook-ingress-replay.md).
  await app.register(webhookRoutes, deps);
  bt('register:webhooks done');
  // S5-D1: findings normalization + scan-run persistence + lifecycle APIs.
  await app.register(scanningRoutes, { prefix: '/api/v1', ...deps });
  bt('register:scanning done');
  // S7-D1: safe production control — authz + approval + request-ID/audit around
  // Dwight's restricted prod command service (S7-D2, @platform/prodctl).
  await app.register(prodRoutes, { prefix: '/api/v1' });
  bt('register:prod done');
  // S8-D1: WP signed mutation-event ingest + JIT grant lifecycle.
  await app.register(wpEventRoutes, { pool: deps.pool });
  bt('register:wp done');
  await app.register(jitRoutes, { pool: deps.pool });
  bt('register:jit done');
  // S9-D1: Telegram ops callback control plane (HMAC-secret webhook + allow-list).
  await app.register(telegramRoutes, { prefix: '/api/v1', ...deps });
  bt('register:telegram done');
  await app.register(secretsRoutes, { prefix: '/api/v1', ...deps });
  bt('register:secrets done');
  // S14-D3: serialized 7-stage deep-audit pipeline (refuses production targets).
  await app.register(deepAuditRoutes, { prefix: '/api/v1', pool: deps.pool, boss: deps.boss });
  bt('register:deep-audit done');
  // S11-D1: safe ephemeral staging lifecycle (provision/test-run/destroy).
  await app.register(stagingRoutes, { prefix: '/api/v1', pool: deps.pool, boss: deps.boss });
  bt('register:staging done');
  // S13-D1: safe WordPress update engine (one unit at a time, staged, approved, promoted).
  await app.register(updateRoutes, { prefix: '/api/v1', pool: deps.pool, boss: deps.boss });
  bt('register:update done');
  // S4A: workload-class queues + admission control telemetry/job ops.
  if (deps.scheduler) {
    await app.register(schedulerRoutes, {
      prefix: '/api/v1',
      pool: deps.pool,
      scheduler: deps.scheduler,
    });
    bt('register:scheduler done');
  }
  // S20-D1: developer-triggered, finding-scoped AI remediation.
  await app.register(remediationRoutes, {
    prefix: '/api/v1',
    pool: deps.pool,
    scheduler: deps.scheduler,
    remediationStore: deps.remediationStore,
  });
  bt('register:remediation done');

  return app;
}
