import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint, mapSeverity } from '../normalize.js';

interface ComposerAdvisory {
  advisoryId?: string;
  packageName?: string;
  title?: string;
  link?: string;
  cve?: string;
  affectedVersions?: string;
  severity?: string;
  sources?: Array<{ name?: string; remoteId?: string }>;
}

// composer audit --format json → { advisories: { pkg: [ ... ] } }
const TABLE: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'low',
};

export const normalizeComposerAudit = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const doc = raw as { advisories?: Record<string, ComposerAdvisory[]> };
  const out: FindingInput[] = [];
  for (const [pkg, list] of Object.entries(doc.advisories ?? {})) {
    for (const a of list) {
      const ruleId = a.advisoryId;
      const location = { path: 'composer.json' };
      out.push({
        finding_fingerprint: makeFingerprint(ctx.tool, ruleId, ctx.target.ref, location),
        rule_id: ruleId,
        title: `${a.packageName ?? pkg}: ${a.title ?? 'advisory'}`,
        severity: mapSeverity(a.severity, TABLE, 'low'),
        native_severity: a.severity,
        confidence: 'firm',
        location,
        cve_ids: a.cve ? [a.cve] : undefined,
        advisory_ids: ruleId ? [ruleId] : undefined,
        remediation: {
          summary: a.affectedVersions ? `Affected: ${a.affectedVersions}` : undefined,
          references: a.link ? [a.link] : undefined,
        },
        metadata: { package: a.packageName ?? pkg, sources: a.sources },
      } satisfies FindingInput);
    }
  }
  return out;
};

export const composerAudit: Adapter = normalizeComposerAudit;
