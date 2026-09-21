import { describe, it, expect } from 'vitest';
import {
  executeCommand,
  resolveCommand,
  ProdCommandRejectedError,
  PROD_ALLOW_LIST,
} from '../src/index.js';

describe('S7-D2 prod command allow-list', () => {
  it('resolves every allow-listed op to a fixed argv shape', () => {
    for (const op of Object.keys(PROD_ALLOW_LIST) as (keyof typeof PROD_ALLOW_LIST)[]) {
      const { bin, argv } = resolveCommand({ op, target: 'web' });
      expect(bin).toBe(PROD_ALLOW_LIST[op].bin);
      expect(argv).toContain('web');
      expect(argv[0]).not.toBe('$TARGET');
    }
  });

  it('rejects unknown ops', () => {
    expect(() => resolveCommand({ op: 'shell' as never, target: 'x' })).toThrow(ProdCommandRejectedError);
  });

  it('rejects targets with illegal characters (flag/shell injection)', () => {
    expect(() => resolveCommand({ op: 'deploy', target: '--rm -rf /' })).toThrow(ProdCommandRejectedError);
    expect(() => resolveCommand({ op: 'deploy', target: 'a; rm -rf /' })).toThrow(ProdCommandRejectedError);
    expect(() => resolveCommand({ op: 'deploy', target: '..' })).toThrow(ProdCommandRejectedError);
  });

  it('hard-rejects docker exec and raw shell', () => {
    // These never reach resolveCommand via the op enum, but resolveCommand must
    // also block the patterns if a caller bypasses the enum.
    expect(() => resolveCommand({ op: 'inventory', target: 'x; docker exec -it web sh' })).toThrow(
      ProdCommandRejectedError,
    );
  });

  it('rejects any non-allow-listed command before execution', async () => {
    // A request that is not one of the 5 ops cannot be constructed through the
    // typed interface; simulate via cast to prove the boundary holds.
    await expect(executeCommand({ op: 'docker-exec' as never, target: 'web' })).rejects.toThrow(
      ProdCommandRejectedError,
    );
  });

  it('executes an allow-listed command end-to-end (no shell)', async () => {
    const res = await executeCommand({ op: 'inventory', target: 'x' });
    // kubectl is absent in CI; expect a non-zero exit, NOT a shell exec.
    expect(res.op).toBe('inventory');
    expect(typeof res.exitCode).toBe('number');
    expect(res.stderr).not.toMatch(/command not found: sh|\/bin\/sh/);
  });
});
