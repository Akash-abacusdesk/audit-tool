// S6-D6 CI battery (D6 / oscar). Run on CI: scanner adapters (D3/D4) scan each headless
// fixture + emit ScanEnvelope -> POST /api/v1/scans/:scanId/findings; assert expected rule_ids.
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as cpExecFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSemgrep, runScan } from '@platform/scanner';
import { HEADLESS_COMBOS } from './headless-oracle.mjs';

const execFile = promisify(cpExecFile);
const ROOT = import.meta.dirname;
const CMS_CONFIG = process.env.CMS_EXPOSURE_CONFIG;

async function runDetection(targetDir, combo) {
  const crossstack = await runScan({
    scanId: `s6-d6-${combo.name}`,
    projectId: 's6-d6',
    tool: 'crossstack',
    workspaceDir: targetDir,
    target: { kind: 'repo', ref: combo.name },
  });
  const cms = CMS_CONFIG
    ? normalizeSemgrep(
        JSON.parse((await execFile('semgrep', ['scan', '--json', '--config', CMS_CONFIG, targetDir], { maxBuffer: 64 * 1024 * 1024 })).stdout),
        { tool: 'semgrep', target: { kind: 'repo', ref: combo.name, branch: null } },
      )
    : [];
  return [...crossstack.findings, ...cms];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  for (const c of HEADLESS_COMBOS) {
    const findings = await runDetection(path.resolve(ROOT, 'headless', c.name), c);
    for (const exp of c.expected) {
      if (!CMS_CONFIG && !exp.ruleId.startsWith('crossstack.')) continue;
      const hit = findings.find((f) => f.rule_id === exp.ruleId && f.severity === exp.severity);
      if (!hit) { console.error(`MISS ${c.name}: expected ${exp.ruleId}/${exp.severity}`); failures++; }
    }
  }
  if (failures) { console.error(`S6 headless battery: ${failures} gaps`); process.exit(1); }
  console.log('S6 headless battery: all combos detected (CI)');
}
