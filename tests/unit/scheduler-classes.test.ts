import { afterEach, describe, expect, it } from 'vitest';
import {
  applyClassOverrides,
  buildWorkerSpec,
  demoJobPayload,
  findWorkloadClass,
  loadWorkloadClasses,
  scanJobPayload,
} from '../../apps/api/src/scheduler/classes.js';

const BASE_COUNT = 12; // + 'notifications' (S9 outbound Telegram alerts)

afterEach(() => {
  // env mutations in these tests must not leak between cases
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SCHED_')) delete process.env[k];
  }
});

describe('workload class registry', () => {
  it('registers all S4A classes including disabled ai_remediation', () => {
    const cs = loadWorkloadClasses();
    expect(cs).toHaveLength(BASE_COUNT);
    const keys = cs.map((c) => c.key);
    for (const k of [
      'critical_interactive',
      'standard_pr',
      'cpu_heavy',
      'browser_heavy',
      'hardening_scan',
      'io_heavy',
      'staging_heavy',
      'ingestion_heavy',
      'network_light',
      'vuln_intel',
      'ai_remediation',
    ]) {
      expect(keys).toContain(k);
    }
    expect(cs.find((c) => c.key === 'ai_remediation')?.disabled).toBe(true);
    // queues unique + namespaced
    const queues = cs.map((c) => c.queue);
    expect(new Set(queues).size).toBe(BASE_COUNT);
    for (const q of queues) expect(q.startsWith('wl.')).toBe(true);
  });

  it('applies env overrides per class', () => {
    process.env.SCHED_CPU_HEAVY_CONCURRENCY = '7';
    process.env.SCHED_CPU_HEAVY_PRIORITY = '11';
    process.env.SCHED_VULN_INTEL_DISABLED = 'true';
    const cs = loadWorkloadClasses().map(applyClassOverrides);
    const cpu = cs.find((c) => c.key === 'cpu_heavy')!;
    expect(cpu.localConcurrency).toBe(7);
    expect(cpu.priority).toBe(11);
    expect(cs.find((c) => c.key === 'vuln_intel')?.disabled).toBe(true);
    // untouched defaults survive
    expect(cs.find((c) => c.key === 'standard_pr')?.localConcurrency).toBe(6);
  });

  it('clamps concurrency to >= 1 and finds by key or queue name', () => {
    process.env.SCHED_VULN_INTEL_CONCURRENCY = '0';
    const cs = loadWorkloadClasses().map(applyClassOverrides);
    expect(cs.find((c) => c.key === 'vuln_intel')!.localConcurrency).toBe(1);
    const any = cs[0]!;
    expect(findWorkloadClass(cs, any.queue)?.key).toBe(any.key);
    expect(findWorkloadClass(cs, 'nope')).toBeUndefined();
  });
});

describe('demo job payload', () => {
  it('defaults to a no-op and rejects out-of-range values', () => {
    expect(demoJobPayload.parse({})).toEqual({ demoMs: 0, failAttempts: 0 });
    expect(() => demoJobPayload.parse({ demoMs: 999_999 })).toThrow();
    expect(() => demoJobPayload.parse({ failAttempts: 9 })).toThrow();
    expect(demoJobPayload.parse({ demoMs: 50, failAttempts: 2 })).toEqual({
      demoMs: 50,
      failAttempts: 2,
    });
  });
});

describe('scan job payload + worker spec composition', () => {
  const SCAN = {
    kind: 'scan',
    tool: 'gitleaks',
    image: 'ghcr.io/acme/gitleaks@sha256:' + 'a'.repeat(64),
    outDir: 'C:/tmp/out',
  };

  it('scan schema is strict: required fields, defaults, rejects malformed', () => {
    expect(scanJobPayload.parse(SCAN).egressMode).toBe('offline');
    // missing image/outDir -> throw (never silently coerced to a demo job)
    expect(() => scanJobPayload.parse({ kind: 'scan', tool: 'x' })).toThrow();
    // unknown egress mode rejected
    expect(() =>
      scanJobPayload.parse({ kind: 'scan', tool: 'x', image: 'i', outDir: 'o', egressMode: 'yolo' })
    ).toThrow();
  });

  it('buildWorkerSpec maps ceilings + correlation labels, never invents limits', () => {
    const limits = { cpuCores: 1, memoryMb: 256, pidsLimit: 64, diskMb: 256, timeoutSeconds: 60 };
    const spec = buildWorkerSpec('job-1', scanJobPayload.parse(SCAN), limits);
    expect(spec.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(spec.jobId).toBe('job-1');
    expect(spec.image).toBe(SCAN.image);
    expect(spec.outDir).toBe('C:/tmp/out');
    expect(spec.limits).toBe(limits); // same object — ceilings passed through verbatim
    expect(spec.egress).toEqual({ mode: 'offline' }); // default
    expect(spec.labels['com.platform.job']).toBe('job-1');
  });

  it('egress bridge mode passes through', () => {
    const parsed = scanJobPayload.parse({ ...SCAN, egressMode: 'bridge' });
    expect(parsed.egressMode).toBe('bridge');
  });
});
