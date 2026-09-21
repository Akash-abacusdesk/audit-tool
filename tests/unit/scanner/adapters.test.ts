import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../../../packages/scanner/src/index.js';
import { normalizeSemgrep } from '../../../packages/scanner/src/adapters/semgrep.js';
import { normalizeGitleaks } from '../../../packages/scanner/src/adapters/gitleaks.js';
import { normalizeTrivy } from '../../../packages/scanner/src/adapters/trivy.js';
import { normalizePackageAudit } from '../../../packages/scanner/src/adapters/packageAudit.js';
import { normalizeComposerAudit } from '../../../packages/scanner/src/adapters/composerAudit.js';
import { normalizePhpcs } from '../../../packages/scanner/src/adapters/phpcs.js';
import { makeFingerprint } from '../../../packages/scanner/src/normalize.js';

const ctx = (tool = 'semgrep'): AdapterContext => ({
  tool,
  target: { kind: 'repo', ref: 'sha-abc123', branch: 'main' },
});

const FP_RE = /^[0-9a-f]{64}$/;

describe('semgrep adapter', () => {
  const raw = {
    results: [
      {
        check_id: 'rules/hardcoded-secret',
        path: 'src/leak.js',
        start: { line: 4, col: 1 },
        end: { line: 4, col: 20 },
        extra: { message: 'Hardcoded secret', severity: 'ERROR', lines: 'const k = "AKIA_LONGKEY1234567890abcdef";' },
      },
      {
        check_id: 'rules/no-eval',
        path: 'src/x.js',
        start: { line: 9 },
        extra: { message: 'Avoid eval', severity: 'WARNING' },
      },
    ],
  };

  it('maps ERROR→high, WARNING→medium', () => {
    const f = normalizeSemgrep(raw, ctx('semgrep'));
    expect(f[0].severity).toBe('high');
    expect(f[0].native_severity).toBe('ERROR');
    expect(f[1].severity).toBe('medium');
  });

  it('redacts secrets from evidence', () => {
    const f = normalizeSemgrep(raw, ctx('semgrep'));
    expect(f[0].evidence).toContain('<redacted:');
    expect(f[0].evidence).not.toContain('AKIA_LONGKEY1234567890abcdef');
  });

  it('produces a stable 64-hex fingerprint', () => {
    const a = normalizeSemgrep(raw, ctx('semgrep'));
    const b = normalizeSemgrep(raw, ctx('semgrep'));
    expect(a[0].finding_fingerprint).toMatch(FP_RE);
    expect(a[0].finding_fingerprint).toBe(b[0].finding_fingerprint);
  });
});

describe('gitleaks adapter', () => {
  const raw = {
    results: [
      {
        RuleID: 'aws-access-token',
        Description: 'AWS Access Token',
        File: 'src/leak.js',
        StartLine: 2,
        EndLine: 2,
        Line: 'aws_key = "AKIA_REAL_SECRET_VALUE_123456"',
        Secret: 'AKIA_REAL_SECRET_VALUE_123456',
        Match: 'AKIA[...]',
      },
    ],
  };

  it('marks every confirmed match high and never emits the raw secret', () => {
    const f = normalizeGitleaks(raw, ctx('gitleaks'));
    expect(f[0].severity).toBe('high');
    expect(f[0].evidence).toContain('Match:');
    expect(f[0].evidence).not.toContain('AKIA_REAL_SECRET_VALUE_123456');
  });
});

describe('trivy adapter', () => {
  const raw = {
    Results: [
      {
        Target: 'package-lock.json',
        Vulnerabilities: [
          {
            VulnerabilityID: 'CVE-2020-1234',
            PkgName: 'lodash',
            InstalledVersion: '4.17.0',
            FixedVersion: '4.17.21',
            Severity: 'HIGH',
            Title: 'Prototype Pollution',
            PrimaryURL: 'https://nvd.nist.gov/CVE-2020-1234',
          },
          {
            VulnerabilityID: 'CVE-2021-9999',
            PkgName: 'left-pad',
            InstalledVersion: '1.0.0',
            Severity: 'UNKNOWN',
            Title: 'Unknown sev',
          },
        ],
      },
    ],
  };

  it('maps severity and extracts CVE ids', () => {
    const f = normalizeTrivy(raw, ctx('trivy'));
    const lodash = f.find((x) => x.rule_id === 'CVE-2020-1234')!;
    expect(lodash.severity).toBe('high');
    expect(lodash.cve_ids).toEqual(['CVE-2020-1234']);
    expect(lodash.remediation?.summary).toContain('4.17.21');
  });

  it('normalizes UNKNOWN→low with tentative confidence', () => {
    const f = normalizeTrivy(raw, ctx('trivy'));
    const unk = f.find((x) => x.rule_id === 'CVE-2021-9999')!;
    expect(unk.severity).toBe('low');
    expect(unk.confidence).toBe('tentative');
  });
});

describe('package-manager audit adapters', () => {
  const raw = {
    vulnerabilities: {
      lodash: {
        name: 'lodash',
        severity: 'high',
        isDirect: false,
        range: '<4.17.21',
        fixAvailable: { name: 'lodash', version: '4.17.21' },
        via: [{ title: 'Prototype Pollution', url: 'https://npmjs.com/advisories/106', severity: 'high', cwe: ['CWE-79'] }],
      },
      'left-pad': {
        name: 'left-pad',
        severity: 'moderate',
        via: [{ title: 'DoS', url: 'https://npmjs.com/advisories/2', severity: 'moderate' }],
      },
    },
  };

  it('npm-audit: moderate→medium, fix summary, package metadata', () => {
    const f = normalizePackageAudit('npm-audit')(raw, ctx('npm-audit'));
    const lp = f.find((x) => x.title.startsWith('left-pad'))!;
    expect(lp.severity).toBe('medium');
    const lodash = f.find((x) => x.title.startsWith('lodash'))!;
    expect(lodash.remediation?.summary).toContain('4.17.21');
    expect(lodash.metadata).toMatchObject({ package: 'lodash' });
  });

  it('pnpm-audit reuses the same normalizer', () => {
    const f = normalizePackageAudit('pnpm-audit')(raw, ctx('pnpm-audit'));
    expect(f.length).toBe(2);
    expect(f[0].finding_fingerprint).toMatch(FP_RE);
  });
});

describe('composer-audit adapter', () => {
  const raw = {
    advisories: {
      'vendor/package': [
        {
          advisoryId: 'PKG-2024-1',
          packageName: 'vendor/package',
          title: 'SQL injection',
          link: 'https://example.com/PKG-2024-1',
          cve: 'CVE-2024-0001',
          affectedVersions: '>=1.0,<1.2',
          severity: 'critical',
        },
      ],
    },
  };

  it('extracts CVE + advisory id and maps severity', () => {
    const f = normalizeComposerAudit(raw, ctx('composer-audit'));
    expect(f[0].severity).toBe('critical');
    expect(f[0].cve_ids).toEqual(['CVE-2024-0001']);
    expect(f[0].advisory_ids).toEqual(['PKG-2024-1']);
  });
});

describe('phpcs adapter', () => {
  const raw = {
    files: {
      '/workspace/theme/functions.php': {
        errors: 1,
        warnings: 1,
        messages: [
          { message: 'Output escaped', type: 'ERROR', line: 12, column: 3, source: 'WordPress.Security.EscapeOutput', severity: 5 },
          { message: 'Prefix', type: 'WARNING', line: 20, column: 1, source: 'WordPress.NamingConventions', severity: 3 },
        ],
      },
    },
  };

  it('maps ERROR→medium, WARNING→low, uses source as rule_id', () => {
    const f = normalizePhpcs(raw, ctx('phpcs-wpcs'));
    const err = f.find((x) => x.rule_id === 'WordPress.Security.EscapeOutput')!;
    expect(err.severity).toBe('medium');
    const warn = f.find((x) => x.rule_id === 'WordPress.NamingConventions')!;
    expect(warn.severity).toBe('low');
  });
});

describe('makeFingerprint', () => {
  it('is stable and tool-scoped', () => {
    const a = makeFingerprint('semgrep', 'r1', 'ref1', { path: 'a.js', start_line: 1 });
    const b = makeFingerprint('semgrep', 'r1', 'ref1', { path: 'a.js', start_line: 1 });
    const c = makeFingerprint('gitleaks', 'r1', 'ref1', { path: 'a.js', start_line: 1 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(FP_RE);
  });
});
