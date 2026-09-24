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

interface TestsslFinding {
  id?: string;
  ip?: string;
  port?: string;
  severity?: string;
  finding?: string;
  cve?: string;
  cwe?: string;
}

/**
 * Every scan run emits an 'OK'/'INFO' row per check even when nothing is
 * wrong (that's how testssl reports "checked, no issue") — those aren't
 * findings, they're clean-check noise, so only true issues are kept.
 */
const NOISE_SEVERITIES = new Set(['OK', 'INFO', 'DEBUG']);

export const normalizeTestssl = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const rows = (Array.isArray(raw) ? raw : []) as TestsslFinding[];
  return rows
    .filter((r) => r.severity && !NOISE_SEVERITIES.has(r.severity.toUpperCase()))
    .map((r) => {
      const location = { path: r.ip ? `${r.ip}:${r.port ?? ''}` : undefined };
      const severity = mapSeverity(r.severity, TABLE, 'info');
      return {
        finding_fingerprint: makeFingerprint(ctx.tool, r.id, ctx.target.ref, location),
        rule_id: r.id,
        title: r.id ? `TLS ${r.id}` : 'testssl-finding',
        description: r.finding,
        severity,
        native_severity: r.severity,
        confidence: 'firm',
        location,
        cve_ids: r.cve ? r.cve.split(/\s+/).filter((c) => c.startsWith('CVE-')) : undefined,
        metadata: { cwe: r.cwe },
      } satisfies FindingInput;
    });
};

export const testssl: Adapter = normalizeTestssl;
