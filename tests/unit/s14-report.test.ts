import { describe, expect, it } from 'vitest';
import {
  buildDeepAuditReport,
  createMockAdapters,
  DeepAuditOrchestrator,
  type DeepAuditTarget,
} from '@platform/shared';

const TARGET: DeepAuditTarget = {
  projectId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
  environment: 'staging',
  ref: 'main',
  isolatedEnv: true,
  clonePath: '/clone/img',
};

describe('S14-D3 deep-audit report aggregation', () => {
  it('counts findings by severity and reports per-stage status', async () => {
    const orch = new DeepAuditOrchestrator({ adapters: createMockAdapters() });
    const state = await orch.run('audit-r', TARGET);
    const report = buildDeepAuditReport(state);

    const expected = state.findings.length;
    expect(report.severityCounts.total).toBe(expected);
    const sum =
      report.severityCounts.critical +
      report.severityCounts.high +
      report.severityCounts.medium +
      report.severityCounts.low +
      report.severityCounts.info;
    expect(sum).toBe(expected);

    expect(Object.keys(report.stageStatus).length).toBe(7);
    for (const s of Object.values(report.stageStatus)) {
      expect(s.status).toBe('done');
      expect(s.findingCount).toBeGreaterThanOrEqual(0);
    }
    expect(report.target).toEqual(TARGET);
  });
});
