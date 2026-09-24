import { describe, expect, it } from 'vitest';
import { buildRecoveryHostPlan, freshnessStatus, receiveBackup, verifyIntegrity } from '../../packages/recovery-host/src/index.js';

describe('@platform/recovery-host', () => {
  it('builds a hardened recovery-host plan isolated from the external Vaultwarden microservice', () => {
    const plan = buildRecoveryHostPlan({
      hostId: 'recovery-1',
      privateAddress: '10.10.0.2',
      vaultwardenApiUrl: 'https://vaultwarden.internal.example',
      backupDir: '/srv/platform-recovery/backups',
      walDir: '/srv/platform-recovery/wal',
      encryptedStorage: true,
      independentAdmin: true,
    });
    expect(plan.vaultwardenIsolated).toBe(true);
    expect(plan.workerAccess).toBe(false);
  });

  it('detects backup hash-chain tampering', () => {
    const a = receiveBackup({ id: 'base', kind: 'postgres-backup', content: 'base', receivedAt: new Date('2026-01-01T00:00:00Z') });
    const b = receiveBackup({ id: 'wal-1', kind: 'postgres-wal', content: 'wal', previousChainHash: a.chainHash, receivedAt: new Date('2026-01-01T00:01:00Z') });
    expect(verifyIntegrity([a, b])).toBe(true);
    expect(verifyIntegrity([a, { ...b, bytes: 999 }])).toBe(false);
  });

  it('reports backup freshness', () => {
    const now = new Date('2026-01-01T01:00:00Z');
    expect(freshnessStatus('2026-01-01T00:45:00Z', 30, now)).toBe('fresh');
    expect(freshnessStatus('2026-01-01T00:00:00Z', 30, now)).toBe('stale');
    expect(freshnessStatus(null, 30, now)).toBe('missing');
  });
});
