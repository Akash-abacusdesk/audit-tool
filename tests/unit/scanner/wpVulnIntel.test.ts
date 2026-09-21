import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { correlateInventory, WP_ADVISORIES } from '../../../packages/scanner/src/index.js';
import { runScan } from '../../../packages/scanner/src/index.js';
import type { WpInventory } from '../../../packages/scanner/src/index.js';

const PROJECT = '11111111-1111-1111-1111-111111111111';

const ctx = { tool: 'wp-vuln-intel', target: { kind: 'repo' as const, ref: 'wp-site-1', branch: 'main' } };

// Section-10 validation fixture: a vulnerable core + plugin, a safe plugin, a
// vulnerable theme. Mirrors the validation check at build-plan L848-851.
const vulnerableSite: WpInventory = {
  core: { version: '6.3.1' }, // < 6.3.2 -> CVE-2023-5561
  plugins: [
    { slug: 'elementor', version: '3.5.0', active: true }, // < 3.6.5 -> CVE-2023-32243
    { slug: 'akismet', version: '5.0.0', active: true }, // no advisory -> no finding
  ],
  themes: [{ slug: 'avada', version: '7.5.0', active: true }], // < 7.11.0 -> file inclusion
};

describe('correlateInventory (S10-D3 correlation core)', () => {
  it('creates the expected findings for a known-vulnerable inventory', () => {
    const f = correlateInventory(vulnerableSite, WP_ADVISORIES, ctx.target.ref);
    const ruleIds = f.map((x) => x.rule_id);
    expect(ruleIds).toContain('wp-vuln-intel.core.core.CVE-2023-5561');
    expect(ruleIds).toContain('wp-vuln-intel.plugin.elementor.CVE-2023-32243');
    expect(ruleIds).toContain('wp-vuln-intel.theme.avada.WPVULNDB-2023-avada');
    // akismet has no advisory -> no false finding
    expect(ruleIds.some((r) => r.includes('akismet'))).toBe(false);
  });

  it('shows the fixed version in remediation when available', () => {
    const f = correlateInventory(vulnerableSite, WP_ADVISORIES, ctx.target.ref);
    const el = f.find((x) => x.rule_id === 'wp-vuln-intel.plugin.elementor.CVE-2023-32243')!;
    expect(el.remediation?.summary).toBe('Update elementor to 3.6.5 or later');
    expect((el.metadata as { fixedVersion?: string }).fixedVersion).toBe('3.6.5');
  });

  it('populates cve_ids and advisory_ids', () => {
    const f = correlateInventory(vulnerableSite, WP_ADVISORIES, ctx.target.ref);
    const core = f.find((x) => x.rule_id === 'wp-vuln-intel.core.core.CVE-2023-5561')!;
    expect(core.cve_ids).toContain('CVE-2023-5561');
    expect(core.advisory_ids?.[0]).toMatch(/^WPVULNDB-/);
  });

  it('carries update-risk metadata (risk + active + majorJump)', () => {
    const f = correlateInventory(vulnerableSite, WP_ADVISORIES, ctx.target.ref);
    const el = f.find((x) => x.rule_id === 'wp-vuln-intel.plugin.elementor.CVE-2023-32243')!;
    const m = el.metadata as { updateRisk: string; active: boolean; majorJump: boolean; componentType: string };
    expect(m.componentType).toBe('plugin');
    expect(m.active).toBe(true);
    expect(m.updateRisk).toBe('high');
  });

  it('produces NO finding for a fully patched (non-vulnerable) version', () => {
    const safe: WpInventory = {
      core: { version: '6.4.0' }, // >= 6.3.2 -> safe
      plugins: [{ slug: 'elementor', version: '3.7.0' }], // >= 3.6.5 -> safe
      themes: [{ slug: 'avada', version: '7.11.2' }], // >= 7.11.0 -> safe
    };
    const f = correlateInventory(safe, WP_ADVISORIES, ctx.target.ref);
    expect(f).toHaveLength(0);
  });

  it('uses a stable dedup key per (rule, component)', () => {
    const f = correlateInventory(vulnerableSite, WP_ADVISORIES, ctx.target.ref);
    const fps = new Set(f.map((x) => x.finding_fingerprint));
    expect(fps.size).toBe(f.length);
  });
});

describe('runScan (wp-vuln-intel rules dispatch)', () => {
  it('reads kevin S10-D4 inventory from the workspace and emits findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wpvuln-'));
    await writeFile(join(dir, 'wp-inventory.json'), JSON.stringify(vulnerableSite), 'utf8');
    const env = await runScan(
      {
        scanId: 'scan-wp-1',
        projectId: PROJECT,
        tool: 'wp-vuln-intel',
        workspaceDir: dir,
        target: ctx.target,
      },
      { keepOutDir: true },
    );
    expect(env.tool.name).toBe('wp-vuln-intel');
    expect(env.status).toBe('completed');
    expect(env.findings.length).toBeGreaterThanOrEqual(3);
    expect(env.findings.some((x) => x.rule_id === 'wp-vuln-intel.plugin.elementor.CVE-2023-32243')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('fails closed (empty findings, completed) when no inventory file is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wpvuln-empty-'));
    const env = await runScan(
      {
        scanId: 'scan-wp-2',
        projectId: PROJECT,
        tool: 'wp-vuln-intel',
        workspaceDir: dir,
        target: ctx.target,
      },
      { keepOutDir: true },
    );
    expect(env.status).toBe('completed');
    expect(env.findings).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });
});
