import { describe, expect, it } from 'vitest';
import {
  buildDeepAuditReport,
  createMockAdapters,
  DeepAuditOrchestrator,
  DEEP_AUDIT_STAGES,
  evaluateStageAdmission,
  isProductionTarget,
  type DeepAuditTarget,
} from '@platform/shared';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';

function staging(over: Partial<DeepAuditTarget> = {}): DeepAuditTarget {
  return {
    projectId: PROJECT,
    environmentId: ENV,
    environment: 'staging',
    ref: 'main',
    isolatedEnv: true,
    ...over,
  };
}

describe('S14-D3 deep-audit orchestrator', () => {
  it('runs all 7 stages IN ORDER and records each', async () => {
    const orch = new DeepAuditOrchestrator({ adapters: createMockAdapters() });
    const order: string[] = [];
    const wrapped = createMockAdapters();
    for (const s of DEEP_AUDIT_STAGES) {
      const orig = wrapped[s];
      const baseExec = orig.exec.bind(orig);
      orig.exec = async (t: DeepAuditTarget) => {
        order.push(s);
        return baseExec(t);
      };
    }
    const orch2 = new DeepAuditOrchestrator({ adapters: wrapped });
    const state = await orch2.run('audit-1', staging());
    expect(order).toEqual([...DEEP_AUDIT_STAGES]);
    expect(state.stages.map((x) => x.stage)).toEqual([...DEEP_AUDIT_STAGES]);
    expect(state.stages.every((x) => x.status === 'done')).toBe(true);
    expect(state.finishedAt).not.toBeNull();
    expect(state.findings.length).toBeGreaterThan(0);
  });

  it('collapses every stage into ONE common findings model', async () => {
    const orch = new DeepAuditOrchestrator({ adapters: createMockAdapters() });
    const state = await orch.run('audit-2', staging());
    // Every finding carries the canonical contract fields.
    for (const f of state.findings) {
      expect(typeof f.finding_fingerprint).toBe('string');
      expect(['critical', 'high', 'medium', 'low', 'info']).toContain(f.severity);
    }
    const report = buildDeepAuditReport(state);
    expect(report.severityCounts.total).toBe(state.findings.length);
  });

  it('refuses a production target before any stage runs', async () => {
    const orch = new DeepAuditOrchestrator({ adapters: createMockAdapters() });
    const prod = staging({ environment: 'production' });
    expect(isProductionTarget(prod)).toBe(true);
    await expect(orch.run('audit-3', prod)).rejects.toThrow(/production/i);
  });

  it('enforces isolation: zap/malware need isolatedEnv, lynis needs clone', async () => {
    expect(evaluateStageAdmission(staging({ isolatedEnv: false }), 'staging-zap').ok).toBe(false);
    expect(evaluateStageAdmission(staging({ isolatedEnv: true }), 'staging-zap').ok).toBe(true);
    expect(evaluateStageAdmission(staging({ isolatedEnv: false }), 'artifact-malware').ok).toBe(false);
    expect(evaluateStageAdmission(staging({ clonePath: undefined }), 'host-lynis').ok).toBe(false);
    expect(evaluateStageAdmission(staging({ environment: 'clone', clonePath: '/clone/img' }), 'host-lynis').ok).toBe(true);
  });
});
