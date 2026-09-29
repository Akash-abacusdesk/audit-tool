import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ResourceLimits, WorkerRunSpec } from '@platform/worker-runtime';

/**
 * S4A workload-class registry. One pg-boss queue per class; every operational
 * knob is env-overridable (SCHED_<KEY>_<SUFFIX>) so no host size is ever
 * assumed — defaults are deliberately modest starting points.
 */
export interface WorkloadClass {
  key: string;
  queue: string;
  priority: number;
  /** Per-node worker concurrency for this class (pg-boss localConcurrency). */
  localConcurrency: number;
  /** Heavy classes are the first excluded when admission degrades. */
  heavy: boolean;
  disabled: boolean;
  retryLimit: number;
  retryDelaySeconds: number;
  /** Native pg-boss expiry backstop for stuck active jobs. */
  expireSeconds: number;
}

const BASE_CLASSES: readonly WorkloadClass[] = [
  { key: 'critical_interactive', queue: 'wl.critical_interactive', priority: 100, localConcurrency: 8, heavy: false, disabled: false, retryLimit: 3, retryDelaySeconds: 5, expireSeconds: 300 },
  { key: 'standard_pr', queue: 'wl.standard_pr', priority: 80, localConcurrency: 6, heavy: false, disabled: false, retryLimit: 3, retryDelaySeconds: 10, expireSeconds: 600 },
  { key: 'ingestion_heavy', queue: 'wl.ingestion_heavy', priority: 70, localConcurrency: 4, heavy: true, disabled: false, retryLimit: 2, retryDelaySeconds: 15, expireSeconds: 900 },
  { key: 'network_light', queue: 'wl.network_light', priority: 65, localConcurrency: 6, heavy: false, disabled: false, retryLimit: 3, retryDelaySeconds: 10, expireSeconds: 300 },
  { key: 'hardening_scan', queue: 'wl.hardening_scan', priority: 60, localConcurrency: 4, heavy: true, disabled: false, retryLimit: 2, retryDelaySeconds: 20, expireSeconds: 1800 },
  { key: 'io_heavy', queue: 'wl.io_heavy', priority: 55, localConcurrency: 4, heavy: true, disabled: false, retryLimit: 2, retryDelaySeconds: 15, expireSeconds: 1200 },
  { key: 'cpu_heavy', queue: 'wl.cpu_heavy', priority: 50, localConcurrency: 2, heavy: true, disabled: false, retryLimit: 2, retryDelaySeconds: 20, expireSeconds: 3600 },
  { key: 'staging_heavy', queue: 'wl.staging_heavy', priority: 45, localConcurrency: 2, heavy: true, disabled: false, retryLimit: 2, retryDelaySeconds: 30, expireSeconds: 3600 },
  { key: 'browser_heavy', queue: 'wl.browser_heavy', priority: 40, localConcurrency: 2, heavy: true, disabled: false, retryLimit: 2, retryDelaySeconds: 20, expireSeconds: 3600 },
  { key: 'vuln_intel', queue: 'wl.vuln_intel', priority: 30, localConcurrency: 2, heavy: false, disabled: false, retryLimit: 2, retryDelaySeconds: 60, expireSeconds: 1800 },
  // Section-20 feature: registered now (queue exists, contract frozen) but
  // never consumes until explicitly enabled.
  { key: 'ai_remediation', queue: 'wl.ai_remediation', priority: 20, localConcurrency: 1, heavy: true, disabled: true, retryLimit: 2, retryDelaySeconds: 30, expireSeconds: 3600 },
  // S9: outbound Telegram alerts. Light/fast, retries a few times in case the
  // Bot API is briefly down; not disabled by default since TelegramClient
  // already no-ops safely (UNAVAILABLE) when no bot token is configured.
  { key: 'notifications', queue: 'wl.notifications', priority: 35, localConcurrency: 4, heavy: false, disabled: false, retryLimit: 4, retryDelaySeconds: 15, expireSeconds: 300 },
];

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

/** Apply SCHED_<KEY>_* overrides on top of one class's defaults. */
export function applyClassOverrides(def: WorkloadClass): WorkloadClass {
  const K = def.key.toUpperCase();
  return {
    ...def,
    priority: envNum(`SCHED_${K}_PRIORITY`) ?? def.priority,
    localConcurrency: Math.max(1, envNum(`SCHED_${K}_CONCURRENCY`) ?? def.localConcurrency),
    disabled: envBool(`SCHED_${K}_DISABLED`) ?? def.disabled,
    retryLimit: Math.max(0, envNum(`SCHED_${K}_RETRY_LIMIT`) ?? def.retryLimit),
    retryDelaySeconds: Math.max(0, envNum(`SCHED_${K}_RETRY_DELAY`) ?? def.retryDelaySeconds),
    expireSeconds: Math.max(1, envNum(`SCHED_${K}_EXPIRE_SECONDS`) ?? def.expireSeconds),
    heavy: envBool(`SCHED_${K}_HEAVY`) ?? def.heavy,
  };
}

/** Full registry with env applied. Fresh each call — tests can mutate env freely. */
export function loadWorkloadClasses(): WorkloadClass[] {
  return BASE_CLASSES.map(applyClassOverrides);
}

export function findWorkloadClass(classes: readonly WorkloadClass[], key: string): WorkloadClass | undefined {
  return classes.find((c) => c.key === key || c.queue === key);
}

/**
 * Demo/proof payload: lets integration batteries exercise completion, retry,
 * timeout and cancellation through the real scheduler envelope before real
 * producers (scans etc.) land in later sections.
 */
export const demoJobPayload = z.object({
  demoMs: z.number().int().min(0).max(120_000).default(0),
  /** Handler throws this many first attempts (derived from job metadata) before succeeding. */
  failAttempts: z.number().int().min(0).max(5).default(0),
});

export type DemoJobPayload = z.infer<typeof demoJobPayload>;

/**
 * Scan-shaped job: executed through pam's @platform/worker-runtime ephemeral
 * container runtime (S4-B). Limits come exclusively from dwight's
 * scanner/profiles.json ceilings via profileForTool — never inline numbers.
 */
export const scanJobPayload = z.object({
  kind: z.literal('scan'),
  tool: z.string().min(1),
  /** digest-pinned preferred; root/empty user denied at runtime pre-flight */
  image: z.string().min(1),
  cmd: z.array(z.string()).optional(),
  /** host dirs staged by the caller; RO /workspace in, RW /out artifacts */
  workspaceDir: z.string().optional(),
  outDir: z.string().min(1),
  egressMode: z.enum(['offline', 'bridge']).default('offline'),
});

export type ScanJobPayload = z.infer<typeof scanJobPayload>;

/**
 * AI-remediation-shaped job (S20-D1): human-triggered, finding-scoped
 * synthetic patch generation. `requestId` is the api_ai_remediation_requests
 * row this job fills in — the route creates it before enqueueing so the
 * developer can poll status even if the worker hasn't picked it up yet.
 */
export const aiRemediationJobPayload = z.object({
  kind: z.literal('ai_remediation'),
  requestId: z.string().uuid(),
  findingId: z.string().uuid(),
  findingSummary: z.string().min(1).max(2000),
  codeContext: z.string().max(20_000),
  stackMetadata: z.string().max(2000).optional(),
  projectPolicy: z.string().max(2000).optional(),
});

export type AiRemediationJobPayload = z.infer<typeof aiRemediationJobPayload>;

/**
 * Notification-shaped job (S9): the row already exists in notification_outbox
 * (status='pending') before this is enqueued — the job just sends it and
 * flips the status. Re-fetching by id (not carrying the body in the payload)
 * keeps the job envelope small and the outbox row the single source of truth.
 */
export const notificationJobPayload = z.object({
  kind: z.literal('notification'),
  outboxId: z.string().uuid(),
});

export type NotificationJobPayload = z.infer<typeof notificationJobPayload>;

/** Payload union as consumed by handleJobs (routed on the `kind` field). */
export type SchedulerJobPayload = ScanJobPayload | AiRemediationJobPayload | NotificationJobPayload | DemoJobPayload;

/** Pure spec composer — unit-testable without touching the runtime/docker. */
export function buildWorkerSpec(
  jobId: string,
  scan: ScanJobPayload,
  limits: ResourceLimits
): WorkerRunSpec {
  return {
    runId: randomUUID(),
    jobId,
    image: scan.image,
    cmd: scan.cmd,
    workspaceDir: scan.workspaceDir,
    outDir: scan.outDir,
    limits,
    egress: { mode: scan.egressMode },
    labels: { 'com.platform.job': jobId },
  };
}
