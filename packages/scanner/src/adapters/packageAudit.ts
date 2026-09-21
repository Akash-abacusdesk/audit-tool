import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint, mapSeverity } from '../normalize.js';

interface AuditAdvisory {
  title?: string;
  url?: string;
  severity?: string;
  cwe?: string[];
  source?: number;
  name?: string;
}

interface AuditVuln {
  name?: string;
  severity?: string;
  via?: Array<string | AuditAdvisory>;
  range?: string;
  fixAvailable?: boolean | { name: string; version: string };
  isDirect?: boolean;
}

// npm/pnpm share a near-identical `audit --json` shape; moderate→medium.
const TABLE: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  MODERATE: 'medium',
  LOW: 'low',
  INFO: 'info',
};

/**
 * Builds an adapter for the npm/pnpm `audit --json` format. The two package
 * managers emit the same vulnerability object shape, so one normalizer serves
 * both; `tool` is stamped for fingerprint + envelope provenance.
 */
export const normalizePackageAudit =
  (tool: string) =>
  (raw: unknown, ctx: AdapterContext): FindingInput[] => {
    const doc = raw as { vulnerabilities?: Record<string, AuditVuln> };
    const out: FindingInput[] = [];
    for (const [pkg, vuln] of Object.entries(doc.vulnerabilities ?? {})) {
      const advisories = (vuln.via ?? []).filter(
        (x): x is AuditAdvisory => typeof x !== 'string',
      );
      for (const a of advisories) {
        const ruleId = a.url ?? String(a.source ?? `${pkg}`);
        const location = { path: 'package.json' };
        const fix = vuln.fixAvailable;
        const fixSummary =
          fix === true
            ? 'Run package audit fix'
            : fix && typeof fix === 'object'
              ? `Upgrade ${fix.name} to ${fix.version}`
              : 'No fix available';
        out.push({
          finding_fingerprint: makeFingerprint(tool, ruleId, ctx.target.ref, location),
          rule_id: ruleId,
          title: `${pkg}: ${a.title ?? 'vulnerable dependency'}`,
          severity: mapSeverity(a.severity ?? vuln.severity, TABLE, 'info'),
          native_severity: a.severity ?? vuln.severity,
          confidence: 'firm',
          location,
          remediation: { summary: fixSummary, references: a.url ? [a.url] : undefined },
          metadata: { package: pkg, range: vuln.range, isDirect: vuln.isDirect, cwe: a.cwe },
        } satisfies FindingInput);
      }
    }
    return out;
  };

export const npmAudit: Adapter = normalizePackageAudit('npm-audit');
export const pnpmAudit: Adapter = normalizePackageAudit('pnpm-audit');
