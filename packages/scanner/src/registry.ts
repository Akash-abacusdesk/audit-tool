import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, Invocation } from './types.js';
import { normalizeSemgrep } from './adapters/semgrep.js';
import { normalizeGitleaks } from './adapters/gitleaks.js';
import { normalizeTrivy } from './adapters/trivy.js';
import { normalizePackageAudit } from './adapters/packageAudit.js';
import { normalizeComposerAudit } from './adapters/composerAudit.js';
import { normalizePhpcs } from './adapters/phpcs.js';
import { normalizeTestssl } from './adapters/testssl.js';
import { normalizeLynis } from './adapters/lynis.js';
import { normalizeZap } from './adapters/zap.js';
import { normalizeClamav } from './adapters/clamav.js';
import { detectCrossStack } from './detectors/crossstack.js';
import { detectWpVulnIntelligence } from './detectors/wpVulnIntel.js';

export interface ScannerDef {
  adapter?: Adapter;
  invocation: Invocation;
}

/**
 * D3-owned registry: every Section-5 scanner, its normalization adapter, and
 * how it is invoked. Image scanners run through @platform/worker-runtime
 * (isolated, digest-pinned); package-manager audits run where the toolchain
 * lives (host exec) until wrapped in a pinned node/php worker image. Both
 * paths converge on the same adapter → ScanEnvelope contract.
 */
export const REGISTRY: Record<string, ScannerDef> = {
  semgrep: {
    adapter: normalizeSemgrep,
    invocation: {
      kind: 'image',
      profile: 'medium',
      outFile: 'semgrep.json',
      egress: 'bridge',
      cmd: (o, workspaceDir) => [
        'scan',
        '--json',
        '--metrics=auto',
        '--output',
        `/out/${o}`,
        '--config',
        workspaceDir && existsSync(join(workspaceDir, '.semgrep.yml')) ? '/workspace/.semgrep.yml' : 'auto',
        '/workspace',
      ],
    },
  },
  gitleaks: {
    adapter: normalizeGitleaks,
    invocation: {
      kind: 'image',
      profile: 'small',
      outFile: 'gitleaks.json',
      egress: 'offline',
      cmd: (o, workspaceDir) => [
        'detect',
        '--no-banner',
        ...(workspaceDir && existsSync(join(workspaceDir, '.git')) ? [] : ['--no-git']),
        '--exit-code',
        '0',
        '--report-format',
        'json',
        '--report-path',
        `/out/${o}`,
        '--source',
        '/workspace',
      ],
    },
  },
  trivy: {
    adapter: normalizeTrivy,
    invocation: {
      kind: 'image',
      profile: 'large',
      outFile: 'trivy.json',
      egress: 'bridge', // needs vuln-DB mirror for fresh scans
      // 20m: trivy's default 5m timeout kills a cold DB download on a slow link. With the persistent cache the DB is kept
      // fresh by the refresher (jobs/trivy-db.ts), so scans skip the inline update and never download.
      cmd: (o) => [
        'fs', '--format', 'json', '--output', `/out/${o}`, '--timeout', '20m',
        ...(process.env.TRIVY_CACHE_HOST_DIR ? ['--skip-db-update'] : []),
        '/workspace',
      ],
      extraScratch: [{ path: '/tmp/trivy-cache', sizeMb: 2048 }],
      persistentCache: { hostEnv: 'TRIVY_CACHE_HOST_DIR', container: '/tmp/trivy-cache' },
    },
  },
  // npm/pnpm/composer audits: normalized identically; run via host toolchain.
  'npm-audit': {
    adapter: normalizePackageAudit('npm-audit'),
    invocation: { kind: 'command', bin: 'npm', args: () => ['audit', '--json'], readFrom: 'stdout' },
  },
  'pnpm-audit': {
    adapter: normalizePackageAudit('pnpm-audit'),
    invocation: { kind: 'command', bin: 'pnpm', args: () => ['audit', '--json'], readFrom: 'stdout' },
  },
  'composer-audit': {
    adapter: normalizeComposerAudit,
    invocation: {
      kind: 'command',
      bin: 'composer',
      args: () => ['audit', '--format', 'json'],
      readFrom: 'stdout',
    },
  },
  'phpcs-wpcs': {
    // planned-s5: image pin + build pending (see scanner/tools.json).
    adapter: normalizePhpcs,
    invocation: {
      kind: 'image',
      profile: 'medium',
      outFile: 'phpcs.json',
      egress: 'offline',
      cmd: (o) => ['--report=json', '--standard=WordPress', '/workspace'],
      readFrom: 'stdout',
    },
  },
  // S14 host-lynis: audits the container's own filesystem/OS, so /workspace is
  // mounted as an approved clone/image root, never a live production host
  // (enforced at the deep-audit admission layer, packages/shared/deep-audit.ts).
  // Lynis has no JSON output mode — `format: 'text'` skips JSON.parse and hands
  // the adapter the raw lynis-report.dat contents (see adapters/lynis.ts).
  lynis: {
    adapter: normalizeLynis,
    invocation: {
      kind: 'image',
      profile: 'small',
      outFile: 'lynis-report.dat',
      egress: 'offline',
      format: 'text',
      // The image entrypoint hardcodes --report-file/--logfile to /tmp before
      // appending these args; a repeated flag overrides the earlier value.
      cmd: (o) => ['audit', 'system', '--report-file', `/out/${o}`, '--logfile', '/out/lynis.log', '--quiet'],
    },
  },
  // S14 tls-network: external, non-destructive TLS/posture check against a
  // managed endpoint URL (never a live customer-serving probe beyond this).
  'testssl.sh': {
    adapter: normalizeTestssl,
    invocation: {
      kind: 'image',
      profile: 'small',
      outFile: 'testssl.json',
      egress: 'bridge', // connects out to the target endpoint by design
      cmd: (o, _workspaceDir, targetUrl) => {
        if (!targetUrl) throw new Error('testssl.sh requires req.targetUrl');
        return ['--jsonfile-pretty', `/out/${o}`, '--quiet', '--warnings', 'batch', targetUrl];
      },
    },
  },
  // S14 staging-zap: DAST against a staging environment ONLY — the deep-audit
  // admission layer refuses this stage outside an isolated sandbox and never
  // against production. "Quick scan" mode (-cmd -quickurl/-quickout) is ZAP's
  // built-in non-interactive CLI scan, invoked through the image's zap-x.sh.
  zap: {
    adapter: normalizeZap,
    invocation: {
      kind: 'image',
      profile: 'large',
      outFile: 'zap.json',
      egress: 'bridge',
      cmd: (o, _workspaceDir, targetUrl) => {
        if (!targetUrl) throw new Error('zap requires req.targetUrl (a staging URL, never production)');
        return ['-cmd', '-quickurl', targetUrl, '-quickout', `/out/${o}`, '-quickprogress'];
      },
    },
  },
  // S14 artifact-malware: scans the mounted workspace/artifact tree. The
  // image's entrypoint always exits 0 (clamscan exits non-zero on a FOUND
  // hit, which worker-runtime would otherwise treat as a run failure) — the
  // FOUND/OK signal lives entirely in stdout text. Verified against a live
  // devsecops/scanner-clamav run this session (Eicar-Test-Signature FOUND).
  clamav: {
    adapter: normalizeClamav,
    invocation: {
      kind: 'image',
      profile: 'medium',
      outFile: 'clamav.log', // unused (readFrom: 'stdout'); required by the type
      egress: 'offline', // signature DB is baked into the image, no freshclam pull needed
      readFrom: 'stdout',
      format: 'text',
      cmd: () => ['-r', '/workspace'],
    },
  },
  // S6-D3: generic cross-stack detection rules (internal detector, not a binary).
  crossstack: {
    invocation: { kind: 'rules', detect: detectCrossStack },
  },
  // S10-D3: WPScan/advisory correlation of installed WP versions (internal engine).
  'wp-vuln-intel': {
    invocation: { kind: 'rules', detect: detectWpVulnIntelligence },
  },
};
