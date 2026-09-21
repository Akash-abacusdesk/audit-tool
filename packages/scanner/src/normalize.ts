import { createHash } from 'node:crypto';
import type { Severity } from '@platform/shared';

/**
 * Stable dedup key for a finding (SCANNING-CONVENTIONS §2):
 *   sha256(tool | rule_id | target.ref | location.path | start_line)
 * Adapter-owned so historical re-normalization is reproducible.
 */
export function makeFingerprint(
  tool: string,
  ruleId: string | undefined,
  targetRef: string,
  location?: { path?: string; start_line?: number },
): string {
  const loc = location?.path ?? '';
  const line = location?.start_line ?? '';
  return createHash('sha256')
    .update(`${tool}|${ruleId ?? ''}|${targetRef}|${loc}|${line}`)
    .digest('hex');
}

/** Adapter-owned native→internal severity map (SCANNING-CONVENTIONS §3). */
export function mapSeverity(
  native: string | undefined,
  table: Record<string, Severity>,
  fallback: Severity = 'info',
): Severity {
  if (!native) return fallback;
  return table[native.toUpperCase()] ?? fallback;
}

// Mask obviously secret material (>=24-char token runs) from free-text
// evidence/code snippets so adapters never emit raw credentials.
const SECRET_RE = /(?<![A-Za-z0-9])([A-Za-z0-9_\-]{24,})(?![A-Za-z0-9])/g;
const KNOWN_SECRET_RE =
  /(?<![A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_\-]{35}|glpat-[A-Za-z0-9_\-]{20,})(?![A-Za-z0-9])/gi;
export function redactSecrets(text: string | undefined, maxLen = 2000): string | undefined {
  if (!text) return undefined;
  const out = text
    .replace(KNOWN_SECRET_RE, (m) => `<redacted:${m.length}>`)
    .replace(SECRET_RE, (m) => `<redacted:${m.length}>`);
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}
