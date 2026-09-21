import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { Pool } from 'pg';

/**
 * Admission control: periodic CPU/RAM/disk + DB-health sampling drives a
 * three-state verdict that decides which workload classes may consume jobs.
 * All thresholds env-tunable (SCHED_ADMISSION_*) — capacity-agnostic by rule.
 *
 * pg-boss v12 has no queue-pause API (verified against installed typings), so
 * "pausing" a class is implemented by its consumer as offWork()/work() toggling
 * in the scheduler — jobs simply stay queued in PG until workers return.
 */

export type AdmissionVerdict = 'ok' | 'degraded' | 'blocked';

export interface AdmissionSample {
  cpuPct: number | null;
  memPct: number;
  diskFreeMb: number | null;
  dbOk: boolean;
}

export interface AdmissionThresholds {
  /** Above this CPU% => degraded. */
  degradedCpuPct: number;
  /** Above this CPU% => blocked (runaway protection). */
  blockedCpuPct: number;
  degradedMemPct: number;
  blockedMemPct: number;
  /** Below this free disk MB => degraded / blocked respectively. */
  degradedDiskFreeMb: number;
  blockedDiskFreeMb: number;
}

export function loadAdmissionThresholds(): AdmissionThresholds {
  const num = (name: string, dflt: number): number => {
    const v = process.env[name];
    const n = v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    degradedCpuPct: num('SCHED_ADMISSION_DEGRADED_CPU_PCT', 85),
    blockedCpuPct: num('SCHED_ADMISSION_BLOCKED_CPU_PCT', 97),
    degradedMemPct: num('SCHED_ADMISSION_DEGRADED_MEM_PCT', 90),
    blockedMemPct: num('SCHED_ADMISSION_BLOCKED_MEM_PCT', 97),
    degradedDiskFreeMb: num('SCHED_ADMISSION_DEGRADED_DISK_FREE_MB', 2048),
    blockedDiskFreeMb: num('SCHED_ADMISSION_BLOCKED_DISK_FREE_MB', 512),
  };
}

/** Pure verdict — unit-testable without touching the OS. */
export function verdictFor(s: AdmissionSample, t: AdmissionThresholds): AdmissionVerdict {
  if (!s.dbOk) return 'blocked';
  const cpuBlocked = s.cpuPct !== null && s.cpuPct >= t.blockedCpuPct;
  const memBlocked = s.memPct >= t.blockedMemPct;
  const diskBlocked = s.diskFreeMb !== null && s.diskFreeMb < t.blockedDiskFreeMb;
  if (cpuBlocked || memBlocked || diskBlocked) return 'blocked';
  const cpuDegraded = s.cpuPct !== null && s.cpuPct >= t.degradedCpuPct;
  const memDegraded = s.memPct >= t.degradedMemPct;
  const diskDegraded = s.diskFreeMb !== null && s.diskFreeMb < t.degradedDiskFreeMb;
  if (cpuDegraded || memDegraded || diskDegraded) return 'degraded';
  return 'ok';
}

/** Rolling CPU sampler: os.cpus() times delta between consecutive samples. */
export class CpuSampler {
  private prev = os.cpus();

  next(): number | null {
    const cur = os.cpus();
    let busy = 0;
    let total = 0;
    for (let i = 0; i < cur.length; i++) {
      const p = this.prev[i];
      if (!p) continue;
      const dTotal =
        cur[i]!.times.user +
        cur[i]!.times.nice +
        cur[i]!.times.sys +
        cur[i]!.times.idle +
        cur[i]!.times.irq -
        (p.times.user + p.times.nice + p.times.sys + p.times.idle + p.times.irq);
      const dIdle = cur[i]!.times.idle - p.times.idle;
      total += dTotal;
      busy += dTotal - dIdle;
    }
    this.prev = cur;
    if (total <= 0) return null;
    return Math.round((busy / total) * 1000) / 10;
  }
}

export async function sampleMemory(): Promise<number> {
  const total = os.totalmem();
  return total > 0 ? Math.round(((total - os.freemem()) / total) * 1000) / 10 : 0;
}

export async function sampleDisk(path: string): Promise<number | null> {
  try {
    const st = await fs.statfs(path);
    if (st.bsize <= 0) return null;
    return Math.round((st.bfree * st.bsize) / 1_048_576);
  } catch {
    return null;
  }
}

export async function sampleDb(pool: Pick<Pool, 'query'>): Promise<boolean> {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('db probe timeout')), 2000)),
    ]);
    return true;
  } catch {
    return false;
  }
}
