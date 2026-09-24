import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../../../packages/scanner/src/index.js';
import { normalizeTestssl } from '../../../packages/scanner/src/adapters/testssl.js';
import { normalizeLynis, parseLynisReport } from '../../../packages/scanner/src/adapters/lynis.js';
import { normalizeZap } from '../../../packages/scanner/src/adapters/zap.js';

const ctx = (tool: string): AdapterContext => ({
  tool,
  target: { kind: 'url', ref: 'https://staging.example.internal' },
});

const FP_RE = /^[0-9a-f]{64}$/;

describe('testssl.sh adapter', () => {
  // Real shape from a live `--jsonfile-pretty` run (testssl.sh 3.2, verified
  // against devsecops/scanner-testssl:3.2 this session): checks are grouped
  // by category under scanResult[], not a flat top-level array.
  const raw = {
    scanResult: [
      {
        targetHost: 'example.com',
        ip: '10.0.0.1',
        port: '443',
        protocols: [
          { id: 'TLS1', severity: 'LOW', finding: 'offered (deprecated)' },
          { id: 'TLS1_2', severity: 'OK', finding: 'offered' },
        ],
        vulnerabilities: [
          { id: 'heartbleed', severity: 'HIGH', cve: 'CVE-2014-0160', cwe: 'CWE-119', finding: 'VULNERABLE' },
          { id: 'CCS', severity: 'OK', cve: 'CVE-2014-0224', finding: 'not vulnerable' },
        ],
        rating: [{ id: 'rating_spec', severity: 'INFO', finding: 'SSL Labs rating guide' }],
      },
    ],
  };

  it('flattens every category array and drops OK/INFO rows as clean-check noise', () => {
    const findings = normalizeTestssl(raw, ctx('testssl.sh'));
    expect(findings.some((f) => f.rule_id === 'CCS')).toBe(false);
    expect(findings.some((f) => f.rule_id === 'rating_spec')).toBe(false);
    expect(findings.length).toBe(2); // TLS1 (protocols) + heartbleed (vulnerabilities)
  });

  it('maps native severities, extracts CVE ids, and tags the source category', () => {
    const findings = normalizeTestssl(raw, ctx('testssl.sh'));
    const heartbleed = findings.find((f) => f.rule_id === 'heartbleed')!;
    expect(heartbleed.severity).toBe('high');
    expect(heartbleed.cve_ids).toEqual(['CVE-2014-0160']);
    expect(heartbleed.metadata?.category).toBe('vulnerabilities');
    expect(heartbleed.location?.path).toBe('10.0.0.1:443');
    expect(FP_RE.test(heartbleed.finding_fingerprint)).toBe(true);
  });
});

describe('lynis report parser + adapter', () => {
  const report = [
    'warning[]=SSH-7408|Root login over SSH is not disabled|-|',
    'suggestion[]=KRNL-5788|Kernel hardening options not fully applied|-|',
    'not-a-finding-line',
    '',
  ].join('\n');

  it('parses warning[]/suggestion[] rows and ignores everything else', () => {
    const rows = parseLynisReport(report);
    expect(rows).toEqual([
      { kind: 'warning', testId: 'SSH-7408', description: 'Root login over SSH is not disabled' },
      { kind: 'suggestion', testId: 'KRNL-5788', description: 'Kernel hardening options not fully applied' },
    ]);
  });

  it('maps warning->high, suggestion->low', () => {
    const findings = normalizeLynis(report, ctx('lynis'));
    expect(findings.find((f) => f.rule_id === 'SSH-7408')!.severity).toBe('high');
    expect(findings.find((f) => f.rule_id === 'KRNL-5788')!.severity).toBe('low');
  });

  it('returns no findings for non-string raw input instead of throwing', () => {
    expect(normalizeLynis(undefined, ctx('lynis'))).toEqual([]);
  });
});

describe('zap adapter', () => {
  const raw = {
    site: [
      {
        '@name': 'https://staging.example.internal',
        alerts: [
          {
            pluginid: '40012',
            alertRef: '40012',
            name: 'Cross Site Scripting (Reflected)',
            riskcode: '3',
            desc: 'XSS via unescaped param',
            solution: 'Escape output',
            cweid: '79',
            instances: [
              { uri: 'https://staging.example.internal/search?q=1', method: 'GET', param: 'q', evidence: '<script>' },
              { uri: 'https://staging.example.internal/comment', method: 'POST', param: 'body', evidence: '<img onerror=1>' },
            ],
          },
          {
            pluginid: '10015',
            alertRef: '10015',
            name: 'Incomplete Cache-control Header',
            riskcode: '1',
            desc: 'informational caching note',
            instances: [{ uri: 'https://staging.example.internal/' }],
          },
        ],
      },
    ],
  };

  it('emits one finding per alert instance, not per alert', () => {
    const findings = normalizeZap(raw, ctx('zap'));
    expect(findings.length).toBe(3); // 2 XSS instances + 1 cache-control
    const xss = findings.filter((f) => f.rule_id === '40012');
    expect(xss.length).toBe(2);
    expect(xss.map((f) => f.location?.url_param).sort()).toEqual([
      'https://staging.example.internal/comment',
      'https://staging.example.internal/search?q=1',
    ]);
  });

  it('maps ZAP riskcode to severity', () => {
    const findings = normalizeZap(raw, ctx('zap'));
    expect(findings.find((f) => f.rule_id === '40012')!.severity).toBe('high');
    expect(findings.find((f) => f.rule_id === '10015')!.severity).toBe('low');
  });
});
