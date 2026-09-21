import { describe, expect, it } from 'vitest';
import {
  verdictFor,
  type AdmissionSample,
  type AdmissionThresholds,
} from '../../apps/api/src/scheduler/admission.js';

const T: AdmissionThresholds = {
  degradedCpuPct: 85,
  blockedCpuPct: 97,
  degradedMemPct: 90,
  blockedMemPct: 97,
  degradedDiskFreeMb: 2048,
  blockedDiskFreeMb: 512,
};

const s = (over: Partial<AdmissionSample>): AdmissionSample => ({
  cpuPct: 20,
  memPct: 40,
  diskFreeMb: 50_000,
  dbOk: true,
  ...over,
});

describe('admission verdict', () => {
  it('healthy host admits', () => {
    expect(verdictFor(s({}), T)).toBe('ok');
  });

  it('db down blocks everything regardless of other signals', () => {
    expect(verdictFor(s({ dbOk: false }), T)).toBe('blocked');
    expect(verdictFor(s({ dbOk: false, cpuPct: 1, memPct: 1 }), T)).toBe('blocked');
  });

  it('resource pressure degrades before it blocks', () => {
    expect(verdictFor(s({ cpuPct: 86 }), T)).toBe('degraded');
    expect(verdictFor(s({ memPct: 91 }), T)).toBe('degraded');
    expect(verdictFor(s({ diskFreeMb: 2000 }), T)).toBe('degraded');
    expect(verdictFor(s({ cpuPct: 98 }), T)).toBe('blocked');
    expect(verdictFor(s({ memPct: 98 }), T)).toBe('blocked');
    expect(verdictFor(s({ diskFreeMb: 100 }), T)).toBe('blocked');
  });

  it('null samplers never block by themselves', () => {
    expect(verdictFor(s({ cpuPct: null, diskFreeMb: null }), T)).toBe('ok');
  });
});
