import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint, mapSeverity } from '../normalize.js';

interface TrivyVuln {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
  References?: string[];
  CweIDs?: string[];
}

interface TrivyResult {
  Target?: string;
  Vulnerabilities?: TrivyVuln[];
}

export const normalizeTrivy = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const doc = raw as { Results?: TrivyResult[] };
  const out: FindingInput[] = [];
  for (const res of doc.Results ?? []) {
    for (const v of res.Vulnerabilities ?? []) {
      const sev = (v.Severity ?? 'UNKNOWN').toUpperCase();
      const severity: Severity = sev === 'UNKNOWN' ? 'low' : (sev.toLowerCase() as Severity);
      const confidence = sev === 'UNKNOWN' ? 'tentative' : 'firm';
      const ruleId = v.VulnerabilityID;
      const location = { path: res.Target };
      const isCve = !!ruleId && ruleId.startsWith('CVE-');
      const refs = v.PrimaryURL ? [v.PrimaryURL, ...(v.References ?? [])] : v.References;
      out.push({
        finding_fingerprint: makeFingerprint(ctx.tool, ruleId, ctx.target.ref, location),
        rule_id: ruleId,
        title: v.PkgName ? `${v.PkgName}@${v.InstalledVersion}: ${ruleId}` : (ruleId ?? 'trivy-finding'),
        description: v.Title ?? v.Description,
        severity,
        native_severity: v.Severity,
        confidence,
        location,
        remediation: {
          summary: v.FixedVersion
            ? `Upgrade ${v.PkgName} to ${v.FixedVersion}`
            : 'No fixed version published',
          references: refs,
        },
        cve_ids: isCve ? [ruleId as string] : undefined,
        metadata: {
          package: v.PkgName,
          installedVersion: v.InstalledVersion,
          fixedVersion: v.FixedVersion,
          cweIds: v.CweIDs,
          primaryUrl: v.PrimaryURL,
        },
      } satisfies FindingInput);
    }
  }
  return out;
};

export const trivy: Adapter = normalizeTrivy;
