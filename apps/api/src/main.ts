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
import { deepAuditStore } from './routes/deep-audit.js';
import { DeepAuditQueue } from './deep-audit/queue.js';
import { PgRemediationStore } from './ai-remediation/pg-store.js';

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

  // Reference worker — proves queue round-trip; real workers land in later sections.
  // pg-boss v12 queues are declarative: without createQueue every poll errors
  // "Queue does not exist" (968KB of stderr in 37min observed live).
  try {
    await boss.inner.createQueue(JOB.exampleCreated);
  } catch {
    // already exists
  }
  await boss.inner.work(JOB.exampleCreated, async (jobs) => {
    for (const job of jobs) {
      console.log(`[worker] ${job.name} received: ${JSON.stringify(job.data)}`);
    }
  });

  // S3-D1B consumer for pam's webhook ingress envelope (payload { eventId }):
  // re-syncs branches/commits/PRs of every repo link matching the delivery's
  // repository. Safe to run before her producer lands — queue just stays empty.
  try {
    await boss.inner.createQueue(JOB.webhookReceived);
  } catch {
    // already exists
  }
  await boss.inner.work(JOB.webhookReceived, async (jobs) => {
    for (const job of jobs) {
      const parsed = webhookReceivedPayload.safeParse(job.data);
      if (!parsed.success) {
        console.error('[worker] git.webhook.received: bad payload', JSON.stringify(job.data));
        continue;
      }
      await handleWebhookReceived(pool, parsed.data.eventId, {
        error: (o, m) => console.error('[worker] git.webhook.received:', m, JSON.stringify(o)),
      });
    }
  });
  // S14-D3: deep-audit pipeline — one stage per job, self-chaining (queue.ts).
  try {
    await boss.inner.createQueue('deep-audit.stage');
  } catch {
    // already exists
  }
  const deepAuditQueue = new DeepAuditQueue(boss.inner, deepAuditStore);
  await boss.inner.work('deep-audit.stage', async (jobs) => {
    for (const job of jobs) {
      const data = job.data as { auditId: string; stage: DeepAuditStage; target: DeepAuditTarget };
      try {
        await deepAuditQueue.handleStageJob(data);
      } catch (err) {
        console.error('[worker] deep-audit.stage:', data.stage, err instanceof Error ? err.message : err);
      }
    }
  });
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
  const scheduler = new Scheduler({ boss: boss.inner, pool, aiProvider, remediationStore });
  await scheduler.start();
  bootAt('scheduler started');
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
    await app.close();
    sweeper.stop();
    scheduler.stop();
    await boss.stop();
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
