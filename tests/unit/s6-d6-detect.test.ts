import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findingInput } from '@platform/shared';
import { HEADLESS_COMBOS } from '../fixtures/headless-oracle.mjs';

const HEADLESS = path.resolve(import.meta.dirname, '../fixtures/headless');

function scanClientExposure(dir: string): string[] {
  const env = fs.readFileSync(path.join(dir, '.env.local'), 'utf8');
  const page = fs.readFileSync(path.join(dir, 'app', 'page.tsx'), 'utf8');
  const out: string[] = [];
  for (const line of env.split('\n')) {
    const m = line.match(/^(NEXT_PUBLIC_\w*(?:ADMIN|API|TOKEN|SECRET|KEY)\w*)=(.*)$/);
    if (m && page.includes(m[1])) out.push(m[1]);
  }
  return out;
}

describe('S6-D6 vulnerable headless fixtures contain detectable client-side secret exposures', () => {
  for (const c of HEADLESS_COMBOS) {
    it(`${c.name}: seeded NEXT_PUBLIC admin token present + referenced in client bundle`, () => {
      expect(scanClientExposure(path.join(HEADLESS, c.name)).length).toBeGreaterThanOrEqual(1);
    });
    it(`${c.name}: server-only credential NOT leaked to client bundle`, () => {
      const page = fs.readFileSync(path.join(HEADLESS, c.name, 'app', 'page.tsx'), 'utf8');
      const server = fs.readFileSync(path.join(HEADLESS, c.name, 'lib', 'server.ts'), 'utf8');
      expect(page.includes(`process.env.${c.serverVar}`)).toBe(false);
      expect(server.includes('import "server-only"')).toBe(true);
    });
  }
  it('clean control: no NEXT_PUBLIC client exposure present', () => {
    expect(scanClientExposure(path.join(HEADLESS, 'clean'))).toHaveLength(0);
  });
});

describe('S6-D6 detection oracle conforms to live FindingInput contract', () => {
  for (const c of HEADLESS_COMBOS) {
    for (const exp of c.expected) {
      it(`${c.name} -> ${exp.ruleId} is schema-valid`, () => {
        const parsed = findingInput.safeParse({
          finding_fingerprint: `fp:${exp.ruleId}:${c.name}`,
          rule_id: exp.ruleId,
          title: `Expected ${exp.ruleId}`,
          severity: exp.severity as findingInput['severity'],
        });
        expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      });
    }
  }
});
