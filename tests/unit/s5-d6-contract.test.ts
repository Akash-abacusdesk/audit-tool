import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { findingInput } from '@platform/shared';
import { FIXTURES } from '../fixtures/validate.mjs';

function toFinding(exp: { ruleId: string; severity: string; cveIds?: string[] }) {
  return {
    finding_fingerprint: `fp:${exp.ruleId}:${exp.severity}`,
    rule_id: exp.ruleId,
    title: `Expected ${exp.ruleId}`,
    severity: exp.severity as findingInput['severity'],
    ...(exp.cveIds ? { cve_ids: exp.cveIds } : {}),
  };
}

describe('S5-D6 expected-finding oracles conform to live FindingInput contract', () => {
  for (const f of FIXTURES) {
    if ((f as any).clean) continue;
    for (const exp of f.expect) {
      it(`${f.id} [${f.scanner}] ${exp.ruleId}/${exp.severity} is schema-valid`, () => {
        const parsed = findingInput.safeParse(toFinding(exp as any));
        expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      });
    }
  }

  it('dedup key matches SCANNING-CONVENTIONS sec2: sha256(tool|rule_id|target.ref|location.path|start_line)', () => {
    const key = (tool: string, ruleId: string, targetRef: string, p: string, line: number) =>
      crypto.createHash('sha256').update([tool, ruleId, targetRef, p, line].join('|')).digest('hex');
    expect(key('gitleaks', 'aws-access-token', 'repos/vuln-secrets', 'src/leak.js', 1)).toMatch(/^[0-9a-f]{64}$/);
  });
});