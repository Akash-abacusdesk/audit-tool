import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint, mapSeverity, redactSecrets } from '../normalize.js';

// SCANNING-CONVENTIONS §3: ERROR→high, WARNING→medium, INFO→low.
const TABLE: Record<string, Severity> = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number; col?: number };
  end?: { line?: number; col?: number };
  extra?: {
    message?: string;
    severity?: string;
    metadata?: Record<string, unknown>;
    lines?: string;
    rule_id?: string;
  };
}

export const normalizeSemgrep = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const doc = raw as { results?: SemgrepResult[] };
  const results = doc.results ?? [];
  return results.map((r) => {
    const ruleId = r.check_id ?? r.extra?.rule_id;
    const location = { path: r.path, start_line: r.start?.line, end_line: r.end?.line };
    const severity = mapSeverity(r.extra?.severity, TABLE, 'info');
    return {
      finding_fingerprint: makeFingerprint(ctx.tool, ruleId, ctx.target.ref, location),
      rule_id: ruleId,
      title: ruleId ?? 'semgrep-finding',
      description: r.extra?.message,
      severity,
      native_severity: r.extra?.severity,
      confidence: 'firm',
      location,
      evidence: redactSecrets(r.extra?.lines),
      metadata: { semgrep: r.extra?.metadata ?? {} },
    } satisfies FindingInput;
  });
};

export const semgrep: Adapter = normalizeSemgrep;
