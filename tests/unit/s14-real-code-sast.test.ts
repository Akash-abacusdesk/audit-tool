import { describe, expect, it, vi } from 'vitest';
import type { DeepAuditTarget } from '@platform/shared';

const runScanMock = vi.fn();
vi.mock('@platform/scanner', () => ({
  runScan: (...args: unknown[]) => runScanMock(...args),
}));

const { RealCodeSastAdapter } = await import('../../apps/api/src/deep-audit/real-adapters.js');

const TARGET: DeepAuditTarget = {
  projectId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
  environment: 'staging',
  ref: 'main',
  isolatedEnv: true,
  workspaceDir: '/tmp/checkout',
};

describe('RealCodeSastAdapter (S14 code-sast, live tool execution)', () => {
  it('refuses to run without a workspaceDir', async () => {
    const adapter = new RealCodeSastAdapter();
    await expect(adapter.exec({ ...TARGET, workspaceDir: undefined })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('runs semgrep and gitleaks against the workspace and merges their findings', async () => {
    runScanMock.mockImplementation(async (req: { tool: string }) => ({
      status: 'completed',
      findings: [{ finding_fingerprint: `${req.tool}-1`, title: req.tool, severity: 'high', confidence: 'firm' }],
    }));
    const adapter = new RealCodeSastAdapter();
    const out = await adapter.exec(TARGET);
    expect(runScanMock).toHaveBeenCalledTimes(2);
    expect(runScanMock.mock.calls.map((c: any[]) => c[0].tool).sort()).toEqual(['gitleaks', 'semgrep']);
    expect(runScanMock.mock.calls.every((c: any[]) => c[0].workspaceDir === '/tmp/checkout')).toBe(true);

    const findings = adapter.normalize(out);
    expect(findings.map((f) => f.finding_fingerprint).sort()).toEqual(['gitleaks-1', 'semgrep-1']);
  });

  it('throws when a tool run fails', async () => {
    runScanMock.mockImplementation(async (req: { tool: string }) =>
      req.tool === 'semgrep'
        ? { status: 'failed', error_summary: 'container OOM', findings: [] }
        : { status: 'completed', findings: [] }
    );
    const adapter = new RealCodeSastAdapter();
    await expect(adapter.exec(TARGET)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
