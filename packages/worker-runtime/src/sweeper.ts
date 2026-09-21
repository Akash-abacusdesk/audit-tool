import type { ContainerRow } from './engine.js';
import {
  listWorkerContainers,
  listWorkerNetworks,
  removeContainer,
  removeNetwork,
} from './engine.js';
import { getActiveRunIds, runIdFromWorkerName } from './registry.js';

const CONTAINER_LABEL = 'com.platform.worker=true';
const NETWORK_LABEL = 'com.platform.worker.net=true';

export interface OrphanSweeperOpts {
  /** poll interval; default from env WORKER_SWEEPER_INTERVAL_MS, else 60000 */
  intervalMs?: number;
  /** only reap things older than this; default env WORKER_ORPHAN_MIN_AGE_MS, else 300000 */
  minAgeMs?: number;
}

export interface OrphanSweepTickResult {
  sweptContainers: number;
  sweptNetworks: number;
}

function resolveOpt(explicit: number | undefined, envKey: string, fallback: number): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  const raw = process.env[envKey];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

export async function sweepOnce(minAgeMs?: number): Promise<OrphanSweepTickResult> {
  const minAge = resolveOpt(minAgeMs, 'WORKER_ORPHAN_MIN_AGE_MS', 300_000);
  const now = Date.now();
  const activeIds = new Set(getActiveRunIds());
  let sweptContainers = 0;
  let sweptNetworks = 0;

  try {
    const containers: ContainerRow[] = await listWorkerContainers(CONTAINER_LABEL);
    for (const row of containers) {
      const runId = runIdFromWorkerName(row.name);
      if (runId !== null && activeIds.has(runId)) continue;
      if (now - row.createdAtMs < minAge) continue;
      try {
        await removeContainer(row.id, true);
        sweptContainers++;
      } catch {}
    }
  } catch {}

  try {
    const networks = await listWorkerNetworks(NETWORK_LABEL);
    for (const net of networks) {
      if (now - net.createdAtMs < minAge) continue;
      // ponytail: substring runId match can over-skip on prefix-colliding ids; swap to exact segment parse if that ever bites
      if ([...activeIds].some((r) => net.name.includes(r))) continue;
      try {
        await removeNetwork(net.name);
        sweptNetworks++;
      } catch {}
    }
  } catch {}

  return { sweptContainers, sweptNetworks };
}

let activeStop: (() => void) | null = null;

export function startOrphanSweeper(opts?: OrphanSweeperOpts): { stop(): void } {
  if (activeStop) return { stop: activeStop };

  const intervalMs = resolveOpt(opts?.intervalMs, 'WORKER_SWEEPER_INTERVAL_MS', 60_000);
  const minAgeMs = resolveOpt(opts?.minAgeMs, 'WORKER_ORPHAN_MIN_AGE_MS', 300_000);

  const timer = setInterval(() => {
    void sweepOnce(minAgeMs).catch(() => {});
  }, intervalMs);
  timer.unref();

  const stop = (): void => {
    clearInterval(timer);
    if (activeStop === stop) activeStop = null;
  };
  activeStop = stop;

  void sweepOnce(minAgeMs).catch(() => {});
  return { stop };
}
