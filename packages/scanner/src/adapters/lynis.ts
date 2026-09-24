import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint } from '../normalize.js';

/**
 * Lynis has no JSON output mode; it writes `lynis-report.dat`, an INI-like
 * `key[]=value` text format where each repeated `warning[]=`/`suggestion[]=`
 * line is one finding: `TEST-ID|description|details|`. Two severities only —
 * warnings (a real hardening gap) map higher than suggestions (advisory).
 */
interface LynisRow {
  kind: 'warning' | 'suggestion';
  testId: string;
  description: string;
}

const SEVERITY: Record<LynisRow['kind'], Severity> = { warning: 'high', suggestion: 'low' };

export function parseLynisReport(text: string): LynisRow[] {
  const rows: LynisRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^(warning|suggestion)\[\]=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, kind, rest] = m;
    const [testId, description] = rest!.split('|');
    if (!testId) continue;
    rows.push({ kind: kind as LynisRow['kind'], testId, description: description ?? '' });
  }
  return rows;
}

export const normalizeLynis = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const rows = parseLynisReport(typeof raw === 'string' ? raw : '');
  return rows.map((r) => ({
    finding_fingerprint: makeFingerprint(ctx.tool, r.testId, ctx.target.ref),
    rule_id: r.testId,
    title: `Lynis ${r.testId}`,
    description: r.description || undefined,
    severity: SEVERITY[r.kind],
    native_severity: r.kind,
    confidence: 'firm',
    metadata: { lynisKind: r.kind },
  } satisfies FindingInput));
};

export const lynis: Adapter = normalizeLynis;
