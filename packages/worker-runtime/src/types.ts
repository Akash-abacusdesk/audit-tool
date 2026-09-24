/**
 * S4-B worker runtime — public contract. Frozen 2026-08-26 with:
 * - jim (S4-A scheduler): consumes runWorkerJob/cancel as stable API;
 *   cancel() idempotent, unknown/finished runId resolves ok.
 * - dwight (S4-C scanner): mounts /workspace RO in, /out RW out, scratch
 *   tmpfs; image-declared user wins (no --user override); limits sourced
 *   from tool/scanner/profiles.json via loadProfile().
 */

export interface ResourceLimits {
  /** whole CPU cores -> docker --cpus */
  cpuCores: number;
  /** -> docker --memory */
  memoryMb: number;
  /** fork-bomb ceiling -> docker --pids-limit */
  pidsLimit: number;
  /** artifact budget for /out; enforced by du-watchdog (bind mounts have no native cap) */
  diskMb: number;
  /** hard budget: SIGTERM at expiry, SIGKILL after grace */
  timeoutSeconds: number;
}

/** offline = per-run INTERNAL docker network (no external route, natively enforced). */
/** bridge = per-run bridge with NAT. Optionally CIDR-scoped via `allowlist` —
 *  host DOCKER-USER iptables rules (Linux only; a no-op elsewhere — egress
 *  stays unrestricted on non-Linux dev, unchanged from before). Rules are
 *  scoped to this run's own network subnet and removed on teardown, so
 *  concurrent runs never share or leak each other's allow-list. */
export type EgressMode = 'offline' | 'bridge';

export interface WorkerRunSpec {
  runId: string;
  /** PLATFORM_JOB_ID injected into the container env when present */
  jobId?: string;
  /** digest-pinned image ref; root/empty user is denied at pre-flight */
  image: string;
  /** argv override; default = image ENTRYPOINT/CMD */
  cmd?: string[];
  /** pierce the image ENTRYPOINT (e.g. ['/bin/sh']) so cmd runs as shell */
  entrypoint?: string[];
  /** host dir mounted read-only at /workspace */
  workspaceDir?: string;
  /** host dir mounted rw at /out — artifacts must survive teardown here */
  outDir: string;
  limits: ResourceLimits;
  /** allowlist: CIDRs the run's network may reach when mode is 'bridge' (offline never needs one). Omitted/empty = unrestricted bridge egress, the pre-existing behavior. */
  egress?: { mode: EgressMode; allowlist?: readonly string[] };
  /**
   * REJECTED at pre-flight: the locked iface (god iface-lock v2) injects
   * PLATFORM_JOB_ID only. Kept in the type so misuse fails loudly with a
   * pointer to change control, not silently.
   */
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /** extra size-capped tmpfs scratch mounts, e.g. [{ path: '/zap', sizeMb: 512 }] */
  extraScratch?: Array<{ path: string; sizeMb: number }>;
}

export type WorkerRunStatus = 'completed' | 'failed' | 'timedOut' | 'cancelled';

export interface WorkerRunResult {
  runId: string;
  status: WorkerRunStatus;
  exitCode: number | null;
  /** true when cancel(runId) terminated the run before natural exit */
  cancelled?: boolean;
  /** true when the watchdog budget expired */
  timedOut?: boolean;
  startedAt: string;
  finishedAt: string;
  logsTail: string;
}

export interface ScratchMount {
  path: string;
  sizeMb: number;
}
