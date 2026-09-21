// S5 validation harness (D6 / oscar) - aligned to dwight S5-D3 adapters + jim S5-D1 sink.
// Live contract: adapters POST ScanEnvelope -> POST /api/v1/scans/:scanId/findings.
// Dedup key (SCANNING-CONVENTIONS sec2): sha256(tool | rule_id | target.ref | location.path | start_line)
// Severity conventions (dwight S5-D3):
//   gitleaks: confirmed match -> high; evidence = Match id only (raw secret REDACTED)
//   semgrep : ERROR->high, WARNING->medium, INFO->low
//   trivy SCA (vuln-deps): CVE in cve_ids; UNKNOWN->low + tentative; remediation 'Upgrade <pkg> to <fixed>'
//   npm/pnpm audit: moderate->medium
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Oracle. `scanner` = envelope tool.name. `ruleId` = expected FindingInput.rule_id.
// ruleId strings are best-known; FINALIZE from CI run of worker.integration.test.ts.
export const FIXTURES = [
  { id: 'vuln-secrets', scanner: 'gitleaks', dir: 'repos/vuln-secrets', expect: [
    { ruleId: 'aws-access-token', severity: 'high', kind: 'should-find', note: 'evidence=Match id (secret redacted)' },
    { ruleId: 'gitleaks-generic-api-key', severity: 'high', kind: 'should-find' },
  ]},
  { id: 'vuln-injection', scanner: 'semgrep', dir: 'security/vuln-injection', expect: [
    { ruleId: 'semgrep-command-injection', severity: 'high', kind: 'should-find' },
    { ruleId: 'semgrep-sql-injection', severity: 'high', kind: 'should-find' },
    { ruleId: 'semgrep-eval-usage', severity: 'medium', kind: 'should-find' },
  ]},
  { id: 'vuln-deps', scanner: 'trivy', dir: 'security/vuln-deps', expect: [
    { ruleId: 'CVE-2020-8203', severity: 'high', kind: 'should-find', cveIds: ['CVE-2020-8203'], note: 'lodash' },
    { ruleId: 'CVE-2021-44906', severity: 'high', kind: 'should-find', cveIds: ['CVE-2021-44906'], note: 'minimist' },
  ]},
  { id: 'web-sqli-xss', scanner: 'semgrep', dir: 'security/web-sqli-xss', expect: [
    { ruleId: 'semgrep-sql-injection', severity: 'high', kind: 'should-find' },
    { ruleId: 'semgrep-xss', severity: 'medium', kind: 'should-find' },
  ]},
  { id: 'gitleaks-fp', scanner: 'gitleaks', dir: 'security/gitleaks-fp', expect: [
    { ruleId: 'aws-access-token', severity: 'high', kind: 'should-not-find', note: 'AWS doc example key; may need allowlist' },
  ]},
  { id: 'clean', dir: 'repos/empty', clean: true, expect: [] },
];

async function runScanners(/* targetDir */) { return []; }

// Run only when executed as a script (CI/worker host with Docker+PG).
if (import.meta.url === `file://${process.argv[1]}`) {
  let failures = 0;
  for (const f of FIXTURES) {
    const target = path.resolve(ROOT, f.dir);
    const findings = await runScanners(target);
    if (f.clean) {
      if (findings.length) { console.error(`CLEAN ${f.id}: expected 0 findings, got ${findings.length}`); failures++; }
      continue;
    }
    for (const exp of f.expect) {
      const hit = findings.find(x =>
        x.rule_id === exp.ruleId && x.severity === exp.severity &&
        (!exp.cveIds || JSON.stringify(x.cve_ids) === JSON.stringify(exp.cveIds)));
      if (exp.kind === 'should-find' && !hit) { console.error(`MISS ${f.id} [${f.scanner}]: expected ${exp.ruleId}/${exp.severity}`); failures++; }
      if (exp.kind === 'should-not-find' && hit) { console.error(`FP   ${f.id} [${f.scanner}]: unexpected ${exp.ruleId}/${exp.severity}`); failures++; }
    }
  }
  if (failures) { console.error(`S5 validation: ${failures} oracle gap(s)`); process.exit(1); }
  console.log('S5 validation harness: oracle aligned to S5-D3 key; live run pending CI (Docker+PG)');
}