import { createHash } from 'node:crypto';

export interface RecoveryHostPlanInput {
  hostId: string;
  privateAddress: string;
  vaultwardenUrl: string;
  backupDir: string;
  walDir: string;
  encryptedStorage: boolean;
  independentAdmin: boolean;
}

export interface RecoveryHostPlan extends RecoveryHostPlanInput {
  vaultwardenIsolated: true;
  workerAccess: false;
}

export function buildRecoveryHostPlan(input: RecoveryHostPlanInput): RecoveryHostPlan {
  if (!input.encryptedStorage) throw new Error('recovery host requires encrypted storage');
  if (!input.independentAdmin) throw new Error('recovery host requires independent admin credentials');
  if (!/^https:\/\//.test(input.vaultwardenUrl)) throw new Error('Vaultwarden URL must be HTTPS');
  if (!input.privateAddress) throw new Error('private address is required');
  return { ...input, vaultwardenIsolated: true, workerAccess: false };
}

export interface BackupRecord {
  id: string;
  kind: 'postgres-backup' | 'postgres-wal' | 'vaultwarden';
  bytes: number;
  sha256: string;
  previousChainHash: string | null;
  chainHash: string;
  receivedAt: string;
}

export function receiveBackup(input: {
  id: string;
  kind: BackupRecord['kind'];
  content: string | Uint8Array;
  previousChainHash?: string | null;
  receivedAt?: Date;
}): BackupRecord {
  const bytes = typeof input.content === 'string' ? Buffer.from(input.content) : Buffer.from(input.content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const previousChainHash = input.previousChainHash ?? null;
  const receivedAt = (input.receivedAt ?? new Date()).toISOString();
  const chainHash = createHash('sha256')
    .update([input.id, input.kind, String(bytes.length), sha256, previousChainHash ?? '', receivedAt].join('|'))
    .digest('hex');
  return { id: input.id, kind: input.kind, bytes: bytes.length, sha256, previousChainHash, chainHash, receivedAt };
}

export function verifyIntegrity(records: readonly BackupRecord[]): boolean {
  let previous: string | null = null;
  for (const record of records) {
    if (record.previousChainHash !== previous) return false;
    const expected: string = createHash('sha256')
      .update([record.id, record.kind, String(record.bytes), record.sha256, record.previousChainHash ?? '', record.receivedAt].join('|'))
      .digest('hex');
    if (record.chainHash !== expected) return false;
    previous = record.chainHash;
  }
  return true;
}

export function freshnessStatus(
  lastReceivedAt: Date | string | null,
  maxAgeMinutes: number,
  now = new Date()
): 'fresh' | 'stale' | 'missing' {
  if (!lastReceivedAt) return 'missing';
  const at = typeof lastReceivedAt === 'string' ? new Date(lastReceivedAt) : lastReceivedAt;
  if (Number.isNaN(at.getTime())) return 'missing';
  return now.getTime() - at.getTime() <= maxAgeMinutes * 60_000 ? 'fresh' : 'stale';
}
