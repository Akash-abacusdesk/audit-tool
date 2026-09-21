export interface ActiveRun {
  /** null between runWorkerJob entry and docker-create completing */
  containerId: string | null;
  startedAtMs: number;
  /** set by cancel() racing the startup window; honored once cid exists */
  cancelRequested?: boolean;
  /** stamped by cancel(): 'user' (external) vs 'runtime' (watchdog/du kill) */
  cancelSource?: 'user' | 'runtime';
}

const active = new Map<string, ActiveRun>();

export function registerRun(runId: string, r: ActiveRun): void {
  active.set(runId, r);
}

export function unregisterRun(runId: string): void {
  active.delete(runId);
}

export function lookupRun(runId: string): ActiveRun | undefined {
  return active.get(runId);
}

export function getActiveRunIds(): string[] {
  return [...active.keys()];
}

const WORKER_NAME_PREFIX = 'platform-wkr-';

export function runIdFromWorkerName(rawName: string): string | null {
  const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
  return name.startsWith(WORKER_NAME_PREFIX)
    ? name.slice(WORKER_NAME_PREFIX.length)
    : null;
}
