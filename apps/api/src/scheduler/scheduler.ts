import type { Pool } from 'pg';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { ApiError, type AiRemediationProvider } from '@platform/shared';
import { cancel, getActiveRunIds, profileForTool, runWorkerJob } from '@platform/worker-runtime';
import {
  aiRemediationJobPayload,
  buildWorkerSpec,
  demoJobPayload,
  findWorkloadClass,
  loadWorkloadClasses,
  notificationJobPayload,
  scanJobPayload,
  type SchedulerJobPayload,
  type WorkloadClass,
} from './classes.js';
import {
  CpuSampler,
  loadAdmissionThresholds,
  sampleDb,
  sampleDisk,
  sampleMemory,
  verdictFor,
  type AdmissionSample,
  type AdmissionThresholds,
  type AdmissionVerdict,
} from './admission.js';
import type { RemediationStore } from '../ai-remediation/store.js';
import type { Queryable } from '../auth/audit.js';
import { asBossDb, withTx } from '../db/pool.js';
import { dispatchAlert, raiseScanFailure } from '../sites/alerts.js';
import { taskDelivery } from '../tasks/portal.js';
import type { TelegramClient } from '@platform/shared';

export interface SchedulerDeps {
  boss: PgBoss;
  pool: Pool;
  /**
   * S20-D1: AI remediation is disabled by default (SCHED_AI_REMEDIATION_DISABLED,
   * classes.ts) so `null` here is the normal, safe default — every dev/test/CI
   * environment runs without a live AI-provider dependency even if the class
   * were flipped on. A queued ai_remediation job with no provider configured
   * fails closed (marked 'failed', never silently dropped).
   */
  aiProvider?: AiRemediationProvider | null;
  remediationStore?: RemediationStore;
  /** S9: outbound Telegram sends. `null`/absent when TELEGRAM_BOT_TOKEN is unset — notification jobs then fail closed (marked 'failed' on the outbox row) rather than silently dropping. */
  telegramClient?: TelegramClient | null;
}

export interface SchedulerTransition {
  at: string;
  from: AdmissionVerdict | null;
  to: AdmissionVerdict;
}

interface ClassRuntime {
  def: WorkloadClass;
  registered: boolean;
  workerId: string | null;
}

const TICK_MS = Math.max(500, Number(process.env.SCHED_ADMISSION_TICK_MS ?? 5000));
const DISK_PATH = process.env.SCHED_ADMISSION_DISK_PATH ?? process.cwd();

/**
 * S4A scheduler: one declarative pg-boss queue per workload class, native
 * localConcurrency limits, admission-driven worker admission (v12 has no
 * queue-pause — exclusion = offWork()/work() toggling; jobs stay persisted in
 * PG until workers return), demo envelope for provable retry/timeout/cancel.
 */
export class Scheduler {
  private readonly classes = loadWorkloadClasses();
  private readonly runtime = new Map<string, ClassRuntime>();
  private readonly cpu = new CpuSampler();
  private readonly thresholds: AdmissionThresholds = loadAdmissionThresholds();
  private verdict: AdmissionVerdict = 'ok';
  private lastSample: AdmissionSample & { sampledAt: string } | null = null;
  private transitions: SchedulerTransition[] = [];
  /** jobId -> runId for in-flight container runs; powers cancel passthrough. */
  private readonly activeRuns = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Register queues + workers and start the admission ticker. */
  async start(): Promise<void> {
    for (const def of this.classes) {
      this.runtime.set(def.key, { def, registered: false, workerId: null });
      if (def.disabled) continue;
      try {
        await this.deps.boss.createQueue(def.queue, {
          policy: 'standard',
          retryLimit: def.retryLimit,
          retryDelay: def.retryDelaySeconds,
          expireInSeconds: def.expireSeconds,
        });
      } catch {
        // already exists
      }
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getVerdict(): AdmissionVerdict {
    return this.verdict;
  }

  hasClass(key: string): boolean {
    return findWorkloadClass(this.classes, key) !== undefined;
  }

  /** Enqueue a demo-envelope job onto a workload class queue. */
  async enqueue(classKey: string, data: object, db?: Queryable): Promise<string | null> {
    const def = this.enabledOrThrow(classKey);
    // With `db` (a caller's transaction) the job is only visible to workers if that transaction commits.
    return this.deps.boss.send(def.queue, data, db ? { db: asBossDb(db) } : undefined);
  }

  async cancelJob(classKey: string, jobId: string): Promise<void> {
    const def = this.enabledOrThrow(classKey);
    // Kill the ephemeral container first (idempotent per S4-B contract),
    // then let pg-boss mark the job cancelled.
    const runId = this.activeRuns.get(jobId);
    if (runId) {
      try {
        await cancel(runId);
      } catch {
        // run already gone — pg-boss cancellation still applies
      }
    }
    await this.deps.boss.cancel(def.queue, jobId);
  }

  async jobStatus(
    classKey: string,
    jobId: string
  ): Promise<Pick<JobWithMetadata, 'id' | 'state' | 'retryCount'> | null> {
    const def = this.enabledOrThrow(classKey);
    const found = await this.deps.boss.findJobs<unknown>(def.queue, { id: jobId });
    const j = found[0];
    return j ? { id: j.id, state: j.state, retryCount: j.retryCount } : null;
  }

  /** Telemetry snapshot incl fresh per-queue counters (best-effort). */
  async telemetry(): Promise<object> {
    const classes = [];
    for (const st of this.runtime.values()) {
      let queueStats: unknown = null;
      if (!st.def.disabled) {
        try {
          queueStats = (await this.deps.boss.getQueueStats(st.def.queue))[0] ?? null;
        } catch {
          queueStats = null;
        }
      }
      classes.push({
        key: st.def.key,
        queue: st.def.queue,
        priority: st.def.priority,
        localConcurrency: st.def.localConcurrency,
        heavy: st.def.heavy,
        disabled: st.def.disabled,
        admittingWorkers: st.registered,
        queueStats,
      });
    }
    return {
      verdict: this.verdict,
      sampledAt: this.lastSample?.sampledAt ?? null,
      sample: this.lastSample,
      thresholds: this.thresholds,
      tickMs: TICK_MS,
      transitions: this.transitions.slice(0, 10),
      activeRuns: getActiveRunIds(),
      classes,
    };
  }

  private enabledOrThrow(classKey: string): WorkloadClass {
    const def = findWorkloadClass(this.classes, classKey);
    if (!def || def.disabled) {
      throw new ApiError('NOT_FOUND', `unknown or disabled workload class: ${classKey}`);
    }
    return def;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const override = process.env.SCHED_ADMISSION_OVERRIDE;
      let sample: AdmissionSample;
      let verdict: AdmissionVerdict;
      // ponytail: forced-verdict knob exists so batteries can prove exclusion
      // deterministically; unset it in any real deployment.
      if (override === 'ok' || override === 'degraded' || override === 'blocked') {
        verdict = override;
        sample = { cpuPct: null, memPct: 0, diskFreeMb: null, dbOk: true };
      } else {
        const dbOk = await sampleDb(this.deps.pool);
        sample = {
          cpuPct: this.cpu.next(),
          memPct: await sampleMemory(),
          diskFreeMb: await sampleDisk(DISK_PATH),
          dbOk,
        };
        verdict = verdictFor(sample, this.thresholds);
      }
      this.lastSample = { ...sample, sampledAt: new Date().toISOString() };
      if (verdict !== this.verdict) {
        this.transitions.unshift({ at: new Date().toISOString(), from: this.verdict, to: verdict });
        this.transitions = this.transitions.slice(0, 50);
        this.verdict = verdict;
        const s = this.lastSample!;
        console.log(
          `[scheduler] admission ${verdict} (cpu=${s.cpuPct ?? 'n/a'}% mem=${s.memPct}% diskFreeMb=${s.diskFreeMb ?? 'n/a'} dbOk=${s.dbOk})`
        );
      }
      await this.reconcile();
    } finally {
      this.ticking = false;
    }
  }

  /** Which classes may consume jobs under the current verdict. */
  private admits(def: WorkloadClass): boolean {
    if (def.disabled) return false;
    switch (this.verdict) {
      case 'ok':
        return true;
      case 'degraded':
        return !def.heavy;
      case 'blocked':
        return def.key === 'critical_interactive';
    }
  }

  private async reconcile(): Promise<void> {
    for (const st of this.runtime.values()) {
      const want = this.admits(st.def);
      if (want && !st.registered) {
        try {
          st.workerId = await this.deps.boss.work(
            st.def.queue,
            { localConcurrency: st.def.localConcurrency, batchSize: 1, includeMetadata: true },
            (jobs) => this.handleJobs(jobs as ReadonlyArray<JobWithMetadata>)
          );
          st.registered = true;
        } catch (err) {
          console.error(`[scheduler] work(${st.def.queue}) failed:`, err);
        }
      } else if (!want && st.registered) {
        try {
          await this.deps.boss.offWork(st.def.queue);
        } catch {
          // worker already gone
        }
        st.registered = false;
        st.workerId = null;
      }
    }
  }

  /**
   * Demo envelope (failAttempts -> real retries via pg-boss metadata) plus the
   * S4-B wiring path: scan-shaped payloads execute through pam's ephemeral
   * container runtime with limits sourced from dwight's profiles.json
   * ceilings. Real producers land in later sections behind these paths.
   */
  private async handleJobs(jobs: ReadonlyArray<JobWithMetadata>): Promise<void> {
    for (const job of jobs) {
      // Route on the declared shape BEFORE validating: a payload declaring
      // itself a scan must FULLY validate as one (fail-closed), while legacy
      // demo payloads stay lenient.
      const declaredScan = (job.data as { kind?: unknown } | null)?.kind === 'scan';
      if (declaredScan) {
        const parsedScan = scanJobPayload.safeParse(job.data ?? {});
        if (!parsedScan.success) {
          console.warn(`[scheduler] bad scan payload on ${job.name}:`, JSON.stringify(job.data));
          throw new Error(`invalid scan payload: ${parsedScan.error.message.slice(0, 200)}`);
        }
        try {
          await this.runScanJob(job.id, job.name, parsedScan.data);
        } catch (err) {
          // pg-boss retries until retryCount reaches retryLimit; only the LAST failure is worth an alert.
          const finalAttempt = job.retryCount >= (job.retryLimit ?? 0);
          if (finalAttempt && parsedScan.data.projectId) await this.alertScanFailure(job.id, parsedScan.data, err);
          throw err;
        }
        continue;
      }
      const declaredAiRemediation = (job.data as { kind?: unknown } | null)?.kind === 'ai_remediation';
      if (declaredAiRemediation) {
        const parsed = aiRemediationJobPayload.safeParse(job.data ?? {});
        if (!parsed.success) {
          console.warn(`[scheduler] bad ai_remediation payload on ${job.name}:`, JSON.stringify(job.data));
          throw new Error(`invalid ai_remediation payload: ${parsed.error.message.slice(0, 200)}`);
        }
        await this.runAiRemediationJob(parsed.data);
        continue;
      }
      const declaredNotification = (job.data as { kind?: unknown } | null)?.kind === 'notification';
      if (declaredNotification) {
        const parsed = notificationJobPayload.safeParse(job.data ?? {});
        if (!parsed.success) {
          console.warn(`[scheduler] bad notification payload on ${job.name}:`, JSON.stringify(job.data));
          throw new Error(`invalid notification payload: ${parsed.error.message.slice(0, 200)}`);
        }
        await this.runNotificationJob(parsed.data);
        continue;
      }
      const parsedDemo = demoJobPayload.safeParse(job.data ?? {});
      if (!parsedDemo.success) {
        console.warn(`[scheduler] bad demo payload on ${job.name}:`, JSON.stringify(job.data));
        continue;
      }
      const { demoMs, failAttempts } = parsedDemo.data;
      if (failAttempts > job.retryCount) {
        throw new Error(`demo failure attempt ${job.retryCount + 1}/${failAttempts}`);
      }
      if (demoMs > 0) await new Promise((r) => setTimeout(r, demoMs));
    }
  }

  /**
   * Execute one scan through the ephemeral runtime. Limits ALWAYS come from
   * profileForTool ceilings — a missing/unknown profile fails the job closed
   * rather than inventing numbers. Cancelled runs return normally (the job was
   * deliberately stopped); failed/timedOut runs throw so pg-boss retry policy
   * decides their fate.
   */
  private async runScanJob(jobId: string, queue: string, scan: Extract<SchedulerJobPayload, { kind: 'scan' }>): Promise<void> {
    const limits = await profileForTool(scan.tool);
    const spec = buildWorkerSpec(jobId, scan, limits);
    this.activeRuns.set(jobId, spec.runId);
    // cancelJob may be handled by ANOTHER replica, which can only mark the pg-boss row cancelled; the container
    // lives here. Watch the row while the run is active and stop our own container when it flips.
    const watcher = setInterval(() => {
      void this.deps.boss
        .findJobs<unknown>(queue, { id: jobId })
        .then((found) => (found[0]?.state === 'cancelled' ? cancel(spec.runId) : undefined))
        .catch(() => {});
    }, Number(process.env.SCHED_CANCEL_POLL_MS ?? 3000));
    try {
      const result = await runWorkerJob(spec);
      if (result.cancelled || result.status === 'cancelled') return;
      if (result.status !== 'completed') {
        throw new Error(`worker run ${result.status} (exit=${result.exitCode}): ${result.logsTail.slice(-200)}`);
      }
    } finally {
      clearInterval(watcher);
      this.activeRuns.delete(jobId);
    }
  }

  /** Best-effort: an alert problem must never mask the scan failure that triggered it. */
  private async alertScanFailure(jobId: string, scan: Extract<SchedulerJobPayload, { kind: 'scan' }>, err: unknown): Promise<void> {
    try {
      const raised = await withTx(this.deps.pool, (tx) =>
        raiseScanFailure(tx, {
          projectId: scan.projectId!,
          scanId: scan.scanId ?? jobId,
          tool: scan.tool,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        })
      );
      if (raised) {
        await dispatchAlert(this, raised);
        await taskDelivery.kick();
      }
    } catch (e) {
      console.error('[scheduler] could not raise the scan-failure alert:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Calls the configured AI provider and persists the result. Fails closed:
   * no provider configured or no store wired is a hard error (marked
   * 'failed' on the request when a store exists), never a silent no-op.
   */
  private async runAiRemediationJob(payload: { requestId: string; findingId: string; findingSummary: string; codeContext: string; stackMetadata?: string; projectPolicy?: string }): Promise<void> {
    const store = this.deps.remediationStore;
    if (!this.deps.aiProvider) {
      const msg = 'ai_remediation job received but no AI provider is configured';
      if (store) await store.markFailed(payload.requestId, msg);
      throw new Error(msg);
    }
    if (store) await store.markRunning(payload.requestId);
    try {
      const result = await this.deps.aiProvider.generatePatch({
        findingId: payload.findingId,
        findingSummary: payload.findingSummary,
        codeContext: payload.codeContext,
        stackMetadata: payload.stackMetadata,
        projectPolicy: payload.projectPolicy,
      });
      if (store) await store.markCompleted(payload.requestId, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (store) await store.markFailed(payload.requestId, msg);
      throw err;
    }
  }

  /**
   * Sends one pending outbox row. Fails closed: no telegramClient configured
   * marks the row 'failed' (with a clear reason) rather than leaving it
   * silently 'pending' forever.
   */
  private async runNotificationJob(payload: { outboxId: string }): Promise<void> {
    const row = (
      await this.deps.pool.query<{ id: string; chat_id: string; body: string; status: string }>(
        `SELECT id, chat_id, body, status FROM notification_outbox WHERE id = $1::uuid`,
        [payload.outboxId]
      )
    ).rows[0];
    if (!row) throw new Error(`notification_outbox row ${payload.outboxId} not found`);
    if (row.status === 'sent') return; // already delivered (e.g. redelivered job)

    if (!this.deps.telegramClient) {
      await this.deps.pool.query(
        `UPDATE notification_outbox SET status = 'failed', error = $2 WHERE id = $1::uuid`,
        [payload.outboxId, 'no TELEGRAM_BOT_TOKEN configured']
      );
      throw new Error('notification job received but no Telegram client is configured');
    }
    try {
      await this.deps.telegramClient.sendMessage(row.chat_id, row.body);
      await this.deps.pool.query(
        `UPDATE notification_outbox SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1::uuid`,
        [payload.outboxId]
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.deps.pool.query(
        `UPDATE notification_outbox SET status = 'failed', error = $2 WHERE id = $1::uuid`,
        [payload.outboxId, msg]
      );
      throw err;
    }
  }
}
