import type { FindingInput } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint } from '../normalize.js';

/**
 * clamscan has no JSON output mode; each infected file gets one plain-text
 * line: `<path>: <signature name> FOUND`. Clean files print `<path>: OK`
 * (ignored — not a finding). Verified against a live devsecops/scanner-clamav
 * run this session (Eicar-Test-Signature FOUND).
 */
export function parseClamscanOutput(text: string): Array<{ path: string; signature: string }> {
  const out: Array<{ path: string; signature: string }> = [];
  for (const line of text.split('\n')) {
    const m = /^(.+): (.+) FOUND$/.exec(line.trimEnd());
    if (!m) continue;
    out.push({ path: m[1]!, signature: m[2]! });
  }
  return out;
}

export const normalizeClamav = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const hits = parseClamscanOutput(typeof raw === 'string' ? raw : '');
  return hits.map((h) => ({
    finding_fingerprint: makeFingerprint(ctx.tool, h.signature, ctx.target.ref, { path: h.path }),
    rule_id: h.signature,
    title: `Malware ${h.signature}`,
    severity: 'critical',
    confidence: 'certain',
    location: { path: h.path },
  } satisfies FindingInput));
};

export const clamav: Adapter = normalizeClamav;
