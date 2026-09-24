import { execFile } from 'node:child_process';

/**
 * S4 egress allowlist — host DOCKER-USER iptables rules (Linux only). Scopes
 * one run's network subnet to only reach the given CIDRs, DROPping
 * everything else. A no-op on non-Linux hosts (Windows dev): egress stays
 * unrestricted there, same as before this existed — never a silent failure,
 * just nothing to enforce with.
 *
 * Deliberately CIDR-only, not hostname-based: resolving/tracking hostnames
 * (registries, vuln-DB mirrors, etc.) into a live-updated allowlist is a
 * bigger feature (DNS-aware ipset) that needs a product decision about
 * exactly which hosts each tool may reach — not invented here. Callers pass
 * CIDRs they've already decided on; today nothing does, so bridge egress
 * remains exactly as unrestricted as before until a caller opts in.
 */

import type { ExecResult } from './engine.js';

export function execIptables(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile('iptables', args, { windowsHide: true }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (err && typeof code !== 'number') {
        reject(err);
        return;
      }
      resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let cachedAvailable: boolean | null = null;

/** True only on Linux with a working `iptables` binary reachable (root/CAP_NET_ADMIN required to actually apply rules). */
export async function isIptablesAvailable(exec: typeof execIptables = execIptables): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    cachedAvailable = (await exec(['-V'])).code === 0;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/** Test-only: clear the availability cache between platform-dependent test cases. */
export function resetIptablesAvailabilityCache(): void {
  cachedAvailable = null;
}

/** One DOCKER-USER rule spec, e.g. ['-s', '172.20.0.0/16', '-d', '10.0.0.5/32', '-j', 'RETURN']. */
export type IptablesRuleSpec = readonly string[];

/**
 * Inserts DOCKER-USER rules scoping `subnet` to only reach `allowlist` CIDRs;
 * everything else from that subnet is DROPped. Returns the exact rule specs
 * applied, in insertion order, so `removeEgressRules` can undo precisely
 * these — never a chain flush, which would affect concurrent runs.
 *
 * Insertion order: DROP is inserted FIRST (iptables -I always inserts at
 * position 1), then each allow rule is inserted after — pushing DROP further
 * down the chain each time — so the final top-to-bottom order is
 * [allowN, ..., allow1, DROP]: every allow is evaluated before the DROP.
 */
export async function applyEgressAllowlist(
  subnet: string,
  allowlist: readonly string[],
  exec: typeof execIptables = execIptables
): Promise<IptablesRuleSpec[]> {
  if (!allowlist.length || !(await isIptablesAvailable(exec))) return [];

  const applied: IptablesRuleSpec[] = [];
  const dropRule = ['-s', subnet, '-j', 'DROP'];
  const dropRes = await exec(['-I', 'DOCKER-USER', ...dropRule]);
  if (dropRes.code !== 0) throw new Error(`iptables -I DOCKER-USER DROP failed: ${dropRes.stderr.trim()}`);
  applied.push(dropRule);

  for (const cidr of allowlist) {
    const allowRule = ['-s', subnet, '-d', cidr, '-j', 'RETURN'];
    const res = await exec(['-I', 'DOCKER-USER', ...allowRule]);
    if (res.code !== 0) throw new Error(`iptables -I DOCKER-USER RETURN(${cidr}) failed: ${res.stderr.trim()}`);
    applied.push(allowRule);
  }
  return applied;
}

/** Removes exactly the rules `applyEgressAllowlist` returned. Best-effort per rule — one already-gone rule never blocks removing the rest. */
export async function removeEgressRules(
  rules: readonly IptablesRuleSpec[],
  exec: typeof execIptables = execIptables
): Promise<void> {
  for (const rule of rules) {
    await exec(['-D', 'DOCKER-USER', ...rule]).catch(() => {});
  }
}
