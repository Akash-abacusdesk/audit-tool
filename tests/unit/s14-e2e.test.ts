import { describe, expect, it, vi } from 'vitest';
import {
  buildDeepAuditReport,
  createMockAdapters,
  DeepAuditOrchestrator,
  DEEP_AUDIT_STAGES,
  type DeepAuditStage,
  type DeepAuditTarget,
} from '@platform/shared';

/**
 * S14-D6 e2e regression: the FULL serialized pipeline must (1) run all 7
 * stages in order, (2) normalize every stage into ONE common findings model,
 * and (3) refuse any production target. All 7 stage tools are mocked.
 */
describe('S14-D6 deep-audit e2e regression', () => {
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const ENV = '22222222-2222-4222-8222-222222222222';

  function target(over: Partial<DeepAuditTarget> = {}): DeepAuditTarget {
    return { projectId: PROJECT, environmentId: ENV, environment: 'staging', ref: 'main', isolatedEnv: true, ...over };
  }

  it('mocks all 7 stages and runs the full serialized pipeline in order', async () => {
    const orch = new DeepAuditOrchestrator({ adapters: createMockAdapters() });
    const seen: DeepAuditStage[] = [];
    const wrapped = createMockAdapters();
    for (const s of DEEP_AUDIT_STAGES) {
      const base = wrapped[s];
      const be = base.exec.bind(base);
      base.exec = vi.fn(async (t: DeepAuditTarget) => {
        seen.push(s);
        return be(t);
      });
    }
    const state = await new DeepAuditOrchestrator({ adapters: wrapped }).run('e2e-1', target());

    // (1) order enforced
    expect(seen).toEqual([...DEEP_AUDIT_STAGES]);
    // (2) one findings model
    expect(state.findings.every((f) => typeof f.finding_fingerprint === 'string')).toBe(true);
    const report = buildDeepAuditReport(state);
    expect(report.severityCounts.total).toBe(state.findings.length);
    expect(report.findings.length).toBe(state.findings.length);
  });

  it('refuses a production target (no stage executes)', async () => {
    const orch = new DeepAuditOrchestrator({ adapters: createMockAdapters() });
    const seen: DeepAuditStage[] = [];
    const wrapped = createMockAdapters();
    for (const s of DEEP_AUDIT_STAGES) {
      const base = wrapped[s];
      const be = base.exec.bind(base);
      base.exec = vi.fn(async (t: DeepAuditTarget) => {
        seen.push(s);
        return be(t);
      });
    }
    await expect(new DeepAuditOrchestrator({ adapters: wrapped }).run('e2e-2', target({ environment: 'production' }))).rejects.toThrow(
      /production/i
    );
    expect(seen.length).toBe(0);
  });
});
