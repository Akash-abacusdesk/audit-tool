import { loadConfig } from './config.js';
import { AnthropicRemediationProvider, JOB, webhookReceivedPayload, type DeepAuditStage, type DeepAuditTarget } from '@platform/shared';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { startBoss } from './plugins/pgboss.js';
import { startWebhookRetention } from './jobs/retention.js';
import { buildApp } from './server.js';
import { handleWebhookReceived } from './git/sync.js';
import { Scheduler } from './scheduler/scheduler.js';
import { startOrphanSweeper } from '@platform/worker-runtime';
import { PgDeepAuditStore } from './deep-audit/pg-store.js';
import { DeepAuditQueue } from './deep-audit/queue.js';
import { PgRemediationStore } from './ai-remediation/pg-store.js';
import { PgStagingStore } from './staging/pg-store.js';
import { StagingWorker } from './staging/worker.js';
import { PgUpdateStore } from './update/pg-store.js';
import { UpdateWorker } from './update/worker.js';
import { telegramClient } from './routes/telegram.js';
import { startReconciler } from './jobs/reconcile.js';
import { lifecycle } from './util/lifecycle.js';

/**
 * Boot path: config → pool → migrations → pg-boss (+ workers) → HTTP → graceful shutdown.
 */
async function main(): Promise<void> {
  const bootAt = (n: string): void => console.log(`[boot] ${n} +${Date.now() - t0}ms`);
  const t0 = Date.now();
  // Loud failures for async paths outside the request lifecycle (tickers,
  // workers): a swallowed rejection must never leave a half-booted process.
  process.on('unhandledRejection', (reason) => {
    console.error('[boot] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[boot] uncaughtException:', err);
    process.exit(1);
  });
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  bootAt('pool created');

  const applied = await migrate(pool);
  if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);
  bootAt('migrations applied');

  const boss = await startBoss(cfg.pgbossUrl, (err) => console.error('pg-boss error:', err));
  bootAt('pg-boss started');

  // pg-boss v12 queues are declarative: without createQueue every poll errors
  // "Queue does not exist" (968KB of stderr in 37min observed live).
  const register = async (
    queue: string,
    handle: (data: unknown) => Promise<void>,
    opts: { expireInSeconds?: number; retryLimit?: number } = {}
  ): Promise<void> => {
    try {
      await boss.inner.createQueue(queue, { retryBackoff: true, ...opts });
    } catch {
      // already exists
    }
    await boss.inner.work(queue, async (jobs) => {
      for (const job of jobs) await handle(job.data);
    });
  };

  // Reference worker — proves queue round-trip; real workers land in later sections.
  await register(JOB.exampleCreated, async (data) => {
    console.log(`[worker] ${JOB.exampleCreated} received: ${JSON.stringify(data)}`);
  });

  // S3-D1B consumer for pam's webhook ingress envelope (payload { eventId }):
  // re-syncs branches/commits/PRs of every repo link matching the delivery's
  // repository. Safe to run before her producer lands — queue just stays empty.
  await register(JOB.webhookReceived, async (data) => {
    const parsed = webhookReceivedPayload.safeParse(data);
    if (!parsed.success) {
      console.error('[worker] git.webhook.received: bad payload', JSON.stringify(data));
      return;
    }
    await handleWebhookReceived(pool, parsed.data.eventId, {
      error: (o, m) => console.error('[worker] git.webhook.received:', m, JSON.stringify(o)),
    });
  });

  // S14-D3: deep-audit pipeline — one stage per job, self-chaining (queue.ts).
  // Stages run real scanners (up to an hour): the 15-minute default expiry would redeliver a live job.
  const deepAuditQueue = new DeepAuditQueue(boss.inner, new PgDeepAuditStore(pool));
  await register(
    'deep-audit.stage',
    async (raw) => {
      const data = raw as { auditId: string; stage: DeepAuditStage; target: DeepAuditTarget };
      try {
        await deepAuditQueue.handleStageJob(data);
      } catch (err) {
        console.error('[worker] deep-audit.stage:', data.stage, err instanceof Error ? err.message : err);
        throw err; // let pg-boss retry (handleStageJob is redelivery-safe)
      }
    },
    { expireInSeconds: 3900, retryLimit: 2 }
  );

  // S11-D2: staging provisioner — real ephemeral WP+MySQL containers.
  const stagingWorker = new StagingWorker(boss.inner, new PgStagingStore(pool));
  await register(JOB.stagingProvision, (d) => stagingWorker.handleProvision(d as never), { expireInSeconds: 1800 });
  await register(JOB.stagingTestRun, (d) => stagingWorker.handleTestRun(d as never), { expireInSeconds: 1800 });
  await register(JOB.stagingDestroy, (d) => stagingWorker.handleDestroy(d as never));

  // S13-D2: update-unit workers — `stage` reuses the same real staging
  // provisioner; `snapshot`/`promote` need a production WP host (Phase 3).
  const updateWorker = new UpdateWorker(boss.inner, new PgUpdateStore(pool));
  await register(JOB.updateSnapshot, (d) => updateWorker.handleSnapshot(d as never), { expireInSeconds: 1800 });
  await register(JOB.updateStage, (d) => updateWorker.handleStage(d as never), { expireInSeconds: 1800 });
  await register(JOB.updatePromote, (d) => updateWorker.handlePromote(d as never), { expireInSeconds: 1800 });
  bootAt('worker registered');

  // S3-D2: daily pg-boss job pruning api_webhook_events at WEBHOOK_RETENTION_DAYS.
  await startWebhookRetention(boss.inner, pool);
  bootAt('retention scheduled');

  // S20-D1: AI remediation provider. `null` unless both an API key and a
  // model are configured — every dev/test/CI environment runs without a live
  // AI-provider dependency, and the workload class is disabled by default
  // regardless (SCHED_AI_REMEDIATION_DISABLED), so an unconfigured deploy
  // simply can't reach this even if someone flips the class on by mistake.
  const aiModel = process.env.AI_REMEDIATION_MODEL;
  const aiProvider =
    process.env.ANTHROPIC_API_KEY && aiModel
      ? new AnthropicRemediationProvider({
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: aiModel,
          allowedModels: (process.env.AI_REMEDIATION_ALLOWED_MODELS ?? aiModel).split(',').map((m) => m.trim()),
        })
      : null;
  const remediationStore = new PgRemediationStore(pool);

  // S4A: workload-class queues, admission control, scheduler workers.
  const scheduler = new Scheduler({ boss: boss.inner, pool, aiProvider, remediationStore, telegramClient });
  await scheduler.start();
  bootAt('scheduler started');
  await startReconciler(boss.inner, pool, scheduler);
  bootAt('pre-buildApp');
  // S4-B: reap leaked worker containers from crashed runs (idempotent, env-tuned).
  const sweeper = startOrphanSweeper();
  bootAt('orphan sweeper started');

  const app = await buildApp({ pool, boss: boss.inner, bossStarted: true, scheduler, remediationStore });
  bootAt('buildApp returned');
  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  bootAt('listening');

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    // Fail /readyz first so the load balancer stops sending traffic, then wind down under a hard deadline.
    lifecycle.draining = true;
    const deadline = setTimeout(() => {
      console.error('shutdown deadline exceeded; forcing exit');
      process.exit(1);
    }, Number(process.env.SHUTDOWN_DEADLINE_MS ?? 30_000));
    deadline.unref();
    await new Promise((r) => setTimeout(r, Number(process.env.SHUTDOWN_DRAIN_MS ?? 3_000)));
    sweeper.stop();
    scheduler.stop();
    await app.close();
    await boss.stop(); // pg-boss waits for in-flight jobs (graceful, its own timeout)
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('fatal boot error:', err);
  process.exit(1);
});
