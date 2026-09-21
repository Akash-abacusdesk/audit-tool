import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, Invocation } from './types.js';
import { normalizeSemgrep } from './adapters/semgrep.js';
import { normalizeGitleaks } from './adapters/gitleaks.js';
import { normalizeTrivy } from './adapters/trivy.js';
import { normalizePackageAudit } from './adapters/packageAudit.js';
import { normalizeComposerAudit } from './adapters/composerAudit.js';
import { normalizePhpcs } from './adapters/phpcs.js';
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
      cmd: (o) => ['fs', '--format', 'json', '--output', `/out/${o}`, '/workspace'],
      extraScratch: [{ path: '/tmp/trivy-cache', sizeMb: 2048 }],
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
  // S6-D3: generic cross-stack detection rules (internal detector, not a binary).
  crossstack: {
    invocation: { kind: 'rules', detect: detectCrossStack },
  },
  // S10-D3: WPScan/advisory correlation of installed WP versions (internal engine).
  'wp-vuln-intel': {
    invocation: { kind: 'rules', detect: detectWpVulnIntelligence },
  },
};
