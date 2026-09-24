import { describe, expect, it, vi } from 'vitest';
import type { DeepAuditTarget } from '@platform/shared';

const runScanMock = vi.fn();
vi.mock('@platform/scanner', () => ({
  runScan: (...args: unknown[]) => runScanMock(...args),
}));

const { RealHostLynisAdapter, RealTlsNetworkAdapter, RealStagingZapAdapter } = await import(
  '../../apps/api/src/deep-audit/real-adapters.js'
);

const BASE: DeepAuditTarget = {
  projectId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
  environment: 'staging',
  ref: 'main',
  isolatedEnv: true,
};

describe('RealHostLynisAdapter (S14 host-lynis)', () => {
  it('refuses without an approved clonePath', async () => {
    const adapter = new RealHostLynisAdapter();
    await expect(adapter.exec(BASE)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('runs lynis against the clone and normalizes to a passthrough of findings', async () => {
    runScanMock.mockResolvedValueOnce({
      status: 'completed',
      findings: [{ finding_fingerprint: 'lynis-1', title: 'SSH-7408', severity: 'high', confidence: 'firm' }],
    });
    const adapter = new RealHostLynisAdapter();
    const target = { ...BASE, clonePath: '/clone/img' };
    const out = await adapter.exec(target);
    expect(runScanMock).toHaveBeenCalledWith(expect.objectContaining({ tool: 'lynis', workspaceDir: '/clone/img' }));
    expect(adapter.normalize(out).map((f) => f.finding_fingerprint)).toEqual(['lynis-1']);
  });
});

describe('RealTlsNetworkAdapter (S14 tls-network)', () => {
  it('refuses without a targetUrl', async () => {
    const adapter = new RealTlsNetworkAdapter();
    await expect(adapter.exec(BASE)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('runs testssl.sh against the target URL', async () => {
    runScanMock.mockResolvedValueOnce({ status: 'completed', findings: [] });
    const adapter = new RealTlsNetworkAdapter();
    const target = { ...BASE, targetUrl: 'https://staging.example.internal' };
    await adapter.exec(target);
    expect(runScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'testssl.sh', targetUrl: 'https://staging.example.internal' })
    );
  });
});

describe('RealStagingZapAdapter (S14 staging-zap)', () => {
  it('refuses outside an isolated sandbox', async () => {
    const adapter = new RealStagingZapAdapter();
    const target = { ...BASE, isolatedEnv: false, targetUrl: 'https://staging.example.internal' };
    await expect(adapter.exec(target)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses without a targetUrl', async () => {
    const adapter = new RealStagingZapAdapter();
    await expect(adapter.exec(BASE)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('runs zap against the staging URL when isolated', async () => {
    runScanMock.mockResolvedValueOnce({ status: 'completed', findings: [] });
    const adapter = new RealStagingZapAdapter();
    const target = { ...BASE, targetUrl: 'https://staging.example.internal' };
    await adapter.exec(target);
    expect(runScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'zap', targetUrl: 'https://staging.example.internal' })
    );
  });

  it('throws when the tool run itself fails', async () => {
    runScanMock.mockResolvedValueOnce({ status: 'failed', error_summary: 'timeout', findings: [] });
    const adapter = new RealStagingZapAdapter();
    const target = { ...BASE, targetUrl: 'https://staging.example.internal' };
    await expect(adapter.exec(target)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
