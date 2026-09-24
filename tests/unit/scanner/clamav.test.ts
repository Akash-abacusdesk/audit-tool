import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../../../packages/scanner/src/index.js';
import { normalizeClamav, parseClamscanOutput } from '../../../packages/scanner/src/adapters/clamav.js';

const ctx: AdapterContext = { tool: 'clamav', target: { kind: 'artifact', ref: 'artifact-1' } };

// Real clamscan output, captured against a live devsecops/scanner-clamav run
// this session (EICAR test string, written inside the container).
const REAL_OUTPUT = [
  '/scan/clean.txt: OK',
  '/scan/eicar.txt: Eicar-Test-Signature FOUND',
  '',
  '----------- SCAN SUMMARY -----------',
  'Known viruses: 3628071',
  'Engine version: 1.5.4',
  'Scanned directories: 1',
  'Scanned files: 2',
  'Infected files: 1',
].join('\n');

describe('clamscan output parser + adapter', () => {
  it('extracts only FOUND lines, ignoring OK lines and the summary', () => {
    const hits = parseClamscanOutput(REAL_OUTPUT);
    expect(hits).toEqual([{ path: '/scan/eicar.txt', signature: 'Eicar-Test-Signature' }]);
  });

  it('normalizes a hit to a critical/certain finding', () => {
    const findings = normalizeClamav(REAL_OUTPUT, ctx);
    expect(findings.length).toBe(1);
    expect(findings[0]).toMatchObject({
      rule_id: 'Eicar-Test-Signature',
      severity: 'critical',
      confidence: 'certain',
      location: { path: '/scan/eicar.txt' },
    });
  });

  it('returns no findings on an all-clean scan', () => {
    const clean = '/scan/a.txt: OK\n/scan/b.txt: OK\n\n----------- SCAN SUMMARY -----------\nInfected files: 0';
    expect(normalizeClamav(clean, ctx)).toEqual([]);
  });
});
