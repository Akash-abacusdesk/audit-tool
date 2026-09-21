import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint, mapSeverity } from '../normalize.js';

interface PhpcsMessage {
  message?: string;
  severity?: number;
  type?: string;
  line?: number;
  column?: number;
  source?: string;
}

interface PhpcsFile {
  errors?: number;
  warnings?: number;
  messages?: PhpcsMessage[];
}

interface PhpcsReport {
  files?: Record<string, PhpcsFile>;
}

// WP coding-standard violations: ERROR→medium, WARNING→low (lint, not CVE).
const TABLE: Record<string, Severity> = { ERROR: 'medium', WARNING: 'low' };

export const normalizePhpcs = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const doc = raw as PhpcsReport;
  const out: FindingInput[] = [];
  for (const [file, f] of Object.entries(doc.files ?? {})) {
    for (const m of f.messages ?? []) {
      const ruleId = m.source;
      const location = { path: file, start_line: m.line, end_line: m.line };
      out.push({
        finding_fingerprint: makeFingerprint(ctx.tool, ruleId, ctx.target.ref, location),
        rule_id: ruleId,
        title: m.source ?? m.message ?? 'phpcs',
        description: m.message,
        severity: mapSeverity(m.type, TABLE, 'low'),
        native_severity: m.type,
        confidence: 'firm',
        location,
        metadata: { phpcsSeverity: m.severity, column: m.column },
      } satisfies FindingInput);
    }
  }
  return out;
};

export const phpcs: Adapter = normalizePhpcs;
