/**
 * S7-D2: restricted production command service.
 *
 * A dedicated, limited service account runs ONLY allow-listed production
 * operations. There is no arbitrary shell: every request is parsed against a
 * fixed allow-list and any command outside it (incl. `docker exec`, raw
 * `/bin/sh`, bare `docker`) is rejected before execution. This is the wrapper
 * Oscar's S7-D6 abuse battery exercises.
 *
 * Authz/audit integration is delegated to S7-D1 (Jim) via the call interface
 * `executeCommand` — this module owns only the allow-list + exec boundary.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Permitted production operations. */
export type ProdOp = 'inventory' | 'health' | 'deploy' | 'plugin-update' | 'rollback';

export interface AllowListEntry {
  op: ProdOp;
  /** binary invoked (must be an absolute, allow-listed path) */
  bin: string;
  /** fixed argv template; `$TARGET` is the only interpolated, validated token */
  args: string[];
}

/**
 * Allow-list. Each entry is a fixed command shape. No free-form argv, no shell,
 * no `docker exec`. `$TARGET` is the single injected operand and is restricted
 * to `[A-Za-z0-9._:-]` so it cannot carry flags or shell metacharacters.
 */
export const PROD_ALLOW_LIST: Record<ProdOp, AllowListEntry> = {
  inventory: { op: 'inventory', bin: '/usr/bin/kubectl', args: ['get', 'all', '-o', 'wide'] },
  health: { op: 'health', bin: '/usr/bin/kubectl', args: ['rollout', 'status', '$TARGET'] },
  deploy: { op: 'deploy', bin: '/usr/bin/kubectl', args: ['apply', '-f', '$TARGET'] },
  'plugin-update': { op: 'plugin-update', bin: '/usr/bin/wp', args: ['plugin', 'update', '$TARGET'] },
  rollback: { op: 'rollback', bin: '/usr/bin/kubectl', args: ['rollout', 'undo', '$TARGET'] },
};

// First char alnum: a leading '-' would let a single-dash flag through as the operand.
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** Hard-rejected substrings — covers docker exec, raw shells, pipes, etc. */
const DENY_PATTERNS = [/docker\s+exec/i, /\/bin\/(sh|bash|zsh|csh)/i, /[|;&`$]/, /\.\./, /--/];

export class ProdCommandRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`prod command rejected: ${reason}`);
    this.name = 'ProdCommandRejectedError';
  }
}

export interface ProdExecRequest {
  op: ProdOp;
  /** operand for the `$TARGET` token (deployment/plugin name, manifest path, etc.) */
  target: string;
  /** optional explicit limit; default 30s */
  timeoutMs?: number;
}

export interface ProdExecResult {
  op: ProdOp;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Validate + resolve a request into a concrete execFile argv. Throws if denied. */
export function resolveCommand(req: ProdExecRequest): { bin: string; argv: string[] } {
  const entry = PROD_ALLOW_LIST[req.op];
  if (!entry) throw new ProdCommandRejectedError(`unknown op: ${String(req.op)}`);
  if (!TARGET_RE.test(req.target)) {
    throw new ProdCommandRejectedError(`target contains illegal characters: ${req.target}`);
  }
  const argv = entry.args.map((a) => (a === '$TARGET' ? req.target : a));
  const joined = `${entry.bin} ${argv.join(' ')}`;
  for (const den of DENY_PATTERNS) {
    if (den.test(joined)) throw new ProdCommandRejectedError(`pattern blocked: ${den}`);
  }
  return { bin: entry.bin, argv };
}

/** Execute an allow-listed production command. Rejects anything off-list first. */
export async function executeCommand(req: ProdExecRequest): Promise<ProdExecResult> {
  const { bin, argv } = resolveCommand(req);
  const timeoutMs = req.timeoutMs ?? 30_000;
  try {
    const { stdout, stderr } = await execFileP(bin, argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { op: req.op, exitCode: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: string; killed?: boolean; stdout?: string; stderr?: string; signal?: string; message?: string };
    if (err.killed) {
      return { op: req.op, exitCode: 124, stdout: err.stdout ?? '', stderr: err.stderr ?? 'timeout' };
    }
    return {
      op: req.op,
      exitCode: err.code && /^\d+$/.test(err.code) ? Number(err.code) : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? 'execution error',
    };
  }
}
