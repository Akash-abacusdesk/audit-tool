import { describe, expect, it } from 'vitest';
import { createMockAdapters, DEEP_AUDIT_STAGES, type DeepAuditTarget } from '@platform/shared';

const TARGET: DeepAuditTarget = {
  projectId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
  environment: 'staging',
  ref: 'main',
  isolatedEnv: true,
};

describe('S14-D3 per-stage adapter normalization', () => {
  const adapters = createMockAdapters();
  for (const stage of DEEP_AUDIT_STAGES) {
    it(`normalizes ${stage} raw output into the common findings contract`, async () => {
      const a = adapters[stage];
      const raw = await a.exec(TARGET);
      const findings = a.normalize(raw);
      expect(Array.isArray(findings)).toBe(true);
      for (const f of findings) {
        expect(typeof f.finding_fingerprint).toBe('string');
        expect(['critical', 'high', 'medium', 'low', 'info']).toContain(f.severity);
        expect(typeof f.title).toBe('string');
      }
      // each stage owns a stable tool label
      expect(a.tool.length).toBeGreaterThan(0);
    });
  }

  it('stage 7 (normalize) dedups + prioritizes by severity', async () => {
    const a = adapters.normalize;
    const raw = await a.exec({ ...TARGET, _findings: [
      { finding_fingerprint: 'x|low|1', rule_id: 'r', title: 'low', severity: 'low', confidence: 'firm' },
      { finding_fingerprint: 'x|low|1', rule_id: 'r', title: 'low', severity: 'low', confidence: 'firm' },
      { finding_fingerprint: 'x|crit|1', rule_id: 'r', title: 'crit', severity: 'critical', confidence: 'firm' },
    ] } as DeepAuditTarget);
    const findings = a.normalize(raw);
    expect(findings.length).toBe(2);
    expect(findings[0]!.severity).toBe('critical');
  });
});
