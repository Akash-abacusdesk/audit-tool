import * as engine from './engine.js';
import { registerRun, unregisterRun, lookupRun, getActiveRunIds } from './registry.js';
import { applyEgressAllowlist, removeEgressRules, type IptablesRuleSpec } from './egress.js';
import type { WorkerRunSpec, WorkerRunResult, ResourceLimits } from './types.js';

export { getActiveRunIds };

interface RunState {
  watchdogFired: boolean;
  userCancelled: boolean;
  diskBreached: boolean;
}

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const termGraceSeconds = (): number => envMs('WORKER_TERM_GRACE_MS', 10_000) / 1000;
const logTailLines = (): number => Math.floor(envMs('WORKER_LOG_TAIL_LINES', 200));
const duPollMs = (): number => envMs('WORKER_OUT_DU_POLL_MS', 30_000);

function assertSpec(spec: WorkerRunSpec): void {
  if (!spec.runId) throw new Error('worker: runId required');
  if (!spec.image) throw new Error('worker: image required');
  if (!spec.outDir) throw new Error('worker: outDir required');
  const l = spec.limits;
  if (!l) throw new Error('worker: limits required (use loadProfile)');
  for (const [k, v] of Object.entries(l)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`worker: limits.${k} must be a positive number`);
    }
  }
}

/** root/empty user is denied; image-declared non-root user wins (no --user override). */
async function preflightNonRoot(image: string): Promise<void> {
  const user = await engine.imageUser(image);
  if (user === null) throw new Error(`worker: image not found: ${image}`);
  if (user === '' || user === '0' || user === 'root') {
    throw new Error(`worker: refusing image with root/undeclared user: ${image} (user='${user || '<empty>'}')`);
  }
}

async function dirBytes(dir: string): Promise<number> {
  const fsp = await import('node:fs/promises');
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) total += await dirBytes(p);
    else {
      try {
        total += (await fsp.stat(p)).size;
      } catch {
        /* raced deletion */
      }
    }
  }
  return total;
}

/**
 * Ephemeral worker lifecycle. Teardown is unconditional: container and
 * per-run network are removed even on failure paths.
 */
export async function runWorkerJob(spec: WorkerRunSpec): Promise<WorkerRunResult> {
  assertSpec(spec);
  await preflightNonRoot(spec.image);

  const limits: ResourceLimits = spec.limits;
  const netName = `platform-wnet-${spec.runId}`;
  const ctrName = `platform-wkr-${spec.runId}`;
  const mode = spec.egress?.mode ?? 'offline';

  await engine.createNetwork(netName, { internal: mode === 'offline' });
  // Egress allowlist (S4, Linux only, opt-in via spec.egress.allowlist): scope
  // this run's own network subnet before the container can send a packet.
  // A no-op — egressRules stays [] — on non-Linux or when no allowlist was
  // requested, so bridge egress is exactly as unrestricted as before by default.
  let egressRules: IptablesRuleSpec[] = [];
  if (mode === 'bridge' && spec.egress?.allowlist?.length) {
    const subnet = await engine.networkSubnet(netName);
    if (subnet) egressRules = await applyEgressAllowlist(subnet, spec.egress.allowlist);
  }

  const state: RunState = { watchdogFired: false, userCancelled: false, diskBreached: false };
  let timer: NodeJS.Timeout | undefined;
  let duTimer: NodeJS.Timeout | undefined;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    // Register BEFORE docker create so cancel() racing the slow Windows
    // startup window marks the run instead of no-op'ing as unknown.
    registerRun(spec.runId, { containerId: null, startedAtMs });

    const scratch = [
      { path: '/tmp', sizeMb: Math.min(512, Math.floor(limits.diskMb)) },
      ...(spec.extraScratch ?? []),
    ];
    const cid = await engine.createWorkerContainer({
      name: ctrName,
      image: spec.image,
      entrypoint: spec.entrypoint,
      cmd: spec.cmd,
      network: netName,
      env: spec.jobId ? { PLATFORM_JOB_ID: spec.jobId } : {},
      labels: spec.labels ?? {},
      roBinds: spec.workspaceDir ? [{ host: spec.workspaceDir, container: '/workspace' }] : [],
      rwBinds: [{ host: spec.outDir, container: '/out' }, ...(spec.extraRwBinds ?? [])],
      tmpfs: scratch,
      limits,
    });

    const entry = lookupRun(spec.runId);
    if (entry) entry.containerId = cid;
    // cancel() arrived during create: honor it now that cid exists,
    // preserving whoever requested it.
    if (entry?.cancelRequested) void cancel(spec.runId, entry.cancelSource ?? 'user');

    // Watchdog: hard budget — SIGTERM now, SIGKILL after grace (docker stop -t).
    timer = setTimeout(() => {
      state.watchdogFired = true;
      void cancel(spec.runId, 'runtime');
    }, limits.timeoutSeconds * 1000);

    // Disk-budget watch on /out (bind mounts have no native size cap).
    const diskCeiling = limits.diskMb * 1024 * 1024;
    duTimer = setInterval(() => {
      void dirBytes(spec.outDir).then((n) => {
        if (n > diskCeiling) {
          state.diskBreached = true;
          void cancel(spec.runId, 'runtime');
        }
      });
    }, duPollMs());
    duTimer.unref?.();

    await engine.startContainer(cid);
    const exitCode = await engine.waitContainer(cid);

    const logsTail = await engine.containerLogs(cid, logTailLines());
    const finishedAt = new Date().toISOString();
    // Disk-budget kill rides the same terminate path as the time watchdog
    // (god /out ruling: watchdog-kill-on-breach surfaces timedOut).
    const done = lookupRun(spec.runId);
    const userCancelled = done?.cancelSource === 'user';
    const killedByRuntime = state.watchdogFired || state.diskBreached;
    const status: WorkerRunResult['status'] = killedByRuntime
      ? 'timedOut'
      : userCancelled
        ? 'cancelled'
        : exitCode === 0
          ? 'completed'
          : 'failed';
    return {
      runId: spec.runId,
      status,
      exitCode,
      cancelled: (userCancelled && !killedByRuntime) || undefined,
      timedOut: killedByRuntime || undefined,
      startedAt,
      finishedAt,
      logsTail:
        (spec.env && Object.keys(spec.env).length > 0
          ? '[runtime] spec.env ignored - locked iface injects PLATFORM_JOB_ID only\n'
          : '') +
        (state.diskBreached ? '[runtime] /out disk budget breached - run terminated\n' : '') +
        logsTail,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (duTimer) clearInterval(duTimer);
    unregisterRun(spec.runId);
    // teardown by name — works even if create succeeded but start failed
    await engine.removeContainer(ctrName, true).catch(() => {});
    if (egressRules.length) await removeEgressRules(egressRules).catch(() => {});
    await engine.removeNetwork(netName).catch(() => {});
  }
}

/**
 * Idempotent mid-run kill: SIGTERM -> WORKER_TERM_GRACE -> SIGKILL via
 * `docker stop -t`. Unknown or already-finished runIds resolve ok so the
 * scheduler never needs existence checks. The run's promise still resolves
 * normally afterwards with cancelled/cancelled-status visible.
 */
export async function cancel(
  runId: string,
  source: 'user' | 'runtime' = 'user',
): Promise<void> {
  const run = lookupRun(runId);
  if (!run) return;
  run.cancelSource = source;
  // Startup window: cid not yet assigned — mark and let runWorkerJob fire
  // the stop once create completes.
  if (!run.containerId) {
    run.cancelRequested = true;
    return;
  }
  await engine.stopContainer(run.containerId, termGraceSeconds()).catch(() => {});
}
