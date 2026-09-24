import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEgressAllowlist,
  isIptablesAvailable,
  removeEgressRules,
  resetIptablesAvailabilityCache,
} from '../../packages/worker-runtime/src/egress.js';

afterEach(() => {
  resetIptablesAvailabilityCache();
});

function fakeExec(available = true) {
  const calls: string[][] = [];
  const exec = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === '-V') return { code: available ? 0 : 1, stdout: available ? 'iptables v1.8.10' : '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  return { exec, calls };
}

// Force Linux for the "available" branch — real behavior is Linux-only, but
// the logic itself (rule construction/order) is what this test verifies, and
// running it only on an actual Linux CI runner would skip it everywhere else.
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('isIptablesAvailable', () => {
  it('is always false on a non-Linux platform, without even checking iptables -V', async () => {
    const { exec, calls } = fakeExec(true);
    const available = await withPlatform('win32', () => isIptablesAvailable(exec));
    expect(available).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('is true on Linux when iptables -V succeeds', async () => {
    const { exec } = fakeExec(true);
    const available = await withPlatform('linux', () => isIptablesAvailable(exec));
    expect(available).toBe(true);
  });

  it('is false on Linux when the iptables binary is missing/broken', async () => {
    const { exec } = fakeExec(false);
    const available = await withPlatform('linux', () => isIptablesAvailable(exec));
    expect(available).toBe(false);
  });
});

describe('applyEgressAllowlist', () => {
  it('is a no-op on non-Linux — returns [] without calling iptables', async () => {
    const { exec, calls } = fakeExec(true);
    const rules = await withPlatform('win32', () => applyEgressAllowlist('172.20.0.0/16', ['10.0.0.1/32'], exec));
    expect(rules).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('is a no-op with an empty allowlist — never inserts a bare DROP-everything rule', async () => {
    const { exec, calls } = fakeExec(true);
    const rules = await withPlatform('linux', () => applyEgressAllowlist('172.20.0.0/16', [], exec));
    expect(rules).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('inserts DROP first, then one RETURN rule per allowed CIDR', async () => {
    const { exec, calls } = fakeExec(true);
    const rules = await withPlatform('linux', () =>
      applyEgressAllowlist('172.20.0.0/16', ['10.0.0.1/32', '10.0.0.2/32'], exec)
    );
    // -V probe, then 1 DROP insert + 2 RETURN inserts.
    const inserts = calls.filter((c) => c[0] === '-I');
    expect(inserts).toEqual([
      ['-I', 'DOCKER-USER', '-s', '172.20.0.0/16', '-j', 'DROP'],
      ['-I', 'DOCKER-USER', '-s', '172.20.0.0/16', '-d', '10.0.0.1/32', '-j', 'RETURN'],
      ['-I', 'DOCKER-USER', '-s', '172.20.0.0/16', '-d', '10.0.0.2/32', '-j', 'RETURN'],
    ]);
    // Returned specs are usable directly as -D args to undo exactly these rules.
    expect(rules).toEqual([
      ['-s', '172.20.0.0/16', '-j', 'DROP'],
      ['-s', '172.20.0.0/16', '-d', '10.0.0.1/32', '-j', 'RETURN'],
      ['-s', '172.20.0.0/16', '-d', '10.0.0.2/32', '-j', 'RETURN'],
    ]);
  });

  it('throws when an insert fails, instead of silently allowing unrestricted egress', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === '-V') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'iptables: Chain does not exist' };
    });
    await expect(withPlatform('linux', () => applyEgressAllowlist('172.20.0.0/16', ['10.0.0.1/32'], exec))).rejects.toThrow(
      /DOCKER-USER DROP failed/
    );
  });
});

describe('removeEgressRules', () => {
  it('issues one -D per rule spec and tolerates an already-gone rule', async () => {
    const exec = vi.fn(async (args: string[]) => (args.includes('10.0.0.2/32') ? { code: 1, stdout: '', stderr: 'no such rule' } : { code: 0, stdout: '', stderr: '' }));
    await removeEgressRules(
      [
        ['-s', 'x', '-d', '10.0.0.1/32', '-j', 'RETURN'],
        ['-s', 'x', '-d', '10.0.0.2/32', '-j', 'RETURN'],
      ],
      exec
    );
    expect(exec).toHaveBeenNthCalledWith(1, ['-D', 'DOCKER-USER', '-s', 'x', '-d', '10.0.0.1/32', '-j', 'RETURN']);
    expect(exec).toHaveBeenNthCalledWith(2, ['-D', 'DOCKER-USER', '-s', 'x', '-d', '10.0.0.2/32', '-j', 'RETURN']);
  });
});
