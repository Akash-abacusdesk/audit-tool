import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint, mapSeverity } from '../normalize.js';

// testssl.sh --jsonfile-pretty native severities.
const TABLE: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  WARN: 'medium',
  OK: 'info',
  INFO: 'info',
  DEBUG: 'info',
};

interface TestsslCheck {
  id?: string;
  severity?: string;
  finding?: string;
  cve?: string;
  cwe?: string;
}

/**
 * `--jsonfile-pretty` groups checks by category under each scanned target,
 * not as one flat list: `{ scanResult: [{ targetHost, ip, port, protocols:
 * [...], ciphers: [...], vulnerabilities: [...], ... }] }`. Every category
 * array shares the same {id, severity, finding, cve?, cwe?} check shape, so
 * they flatten uniformly — this is real testssl.sh 3.2 output, not a guess.
 */
interface TestsslTarget {
  ip?: string;
  port?: string;
  [category: string]: unknown;
}

const NON_CHECK_KEYS = new Set(['targetHost', 'ip', 'port', 'rDNS', 'service']);

/**
 * Every scan run emits an 'OK'/'INFO' row per check even when nothing is
 * wrong (that's how testssl reports "checked, no issue") — those aren't
 * findings, they're clean-check noise, so only true issues are kept.
 */
const NOISE_SEVERITIES = new Set(['OK', 'INFO', 'DEBUG']);

export const normalizeTestssl = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const doc = raw as { scanResult?: TestsslTarget[] };
  const out: FindingInput[] = [];
  for (const t of doc.scanResult ?? []) {
    const location = { path: t.ip ? `${t.ip}:${t.port ?? ''}` : undefined };
    for (const [key, value] of Object.entries(t)) {
      if (NON_CHECK_KEYS.has(key) || !Array.isArray(value)) continue;
      for (const r of value as TestsslCheck[]) {
        if (!r.severity || NOISE_SEVERITIES.has(r.severity.toUpperCase())) continue;
        const severity = mapSeverity(r.severity, TABLE, 'info');
        out.push({
          finding_fingerprint: makeFingerprint(ctx.tool, r.id, ctx.target.ref, location),
          rule_id: r.id,
          title: r.id ? `TLS ${r.id}` : 'testssl-finding',
          description: r.finding,
          severity,
          native_severity: r.severity,
          confidence: 'firm',
          location,
          cve_ids: r.cve ? r.cve.split(/\s+/).filter((c) => c.startsWith('CVE-')) : undefined,
          metadata: { cwe: r.cwe, category: key },
        } satisfies FindingInput);
      }
    }
  }
  return out;
};

export const testssl: Adapter = normalizeTestssl;
