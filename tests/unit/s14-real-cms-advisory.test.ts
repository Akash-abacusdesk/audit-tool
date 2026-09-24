import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import type { DeepAuditTarget } from '@platform/shared';
import { RealCmsAdvisoryAdapter } from '../../apps/api/src/deep-audit/real-adapters.js';

const BASE: DeepAuditTarget = {
  projectId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
  environment: 'staging',
  ref: 'wp-site-1',
  isolatedEnv: true,
};

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('RealCmsAdvisoryAdapter (S14 cms-advisory, real in-process detector)', () => {
  it('refuses without a workspaceDir', async () => {
    const adapter = new RealCmsAdvisoryAdapter();
    await expect(adapter.exec(BASE)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('correlates a real S10 WP inventory file against the advisory feed — no mocking', async () => {
    dir = await mkdtemp(join(tmpdir(), 'deep-audit-cms-'));
    await writeFile(
      join(dir, 'wp-inventory.json'),
      JSON.stringify({
        core: { version: '6.3.1' }, // < 6.3.2 -> CVE-2023-5561
        plugins: [{ slug: 'elementor', version: '3.5.0', active: true }], // < 3.6.5 -> CVE-2023-32243
        themes: [],
      })
    );
    const adapter = new RealCmsAdvisoryAdapter();
    const out = await adapter.exec({ ...BASE, workspaceDir: dir });
    const findings = adapter.normalize(out);
    expect(findings.map((f) => f.rule_id)).toEqual(
      expect.arrayContaining(['wp-vuln-intel.core.core.CVE-2023-5561', 'wp-vuln-intel.plugin.elementor.CVE-2023-32243'])
    );
  });

  it('returns no findings when no inventory file is present (non-WP project)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'deep-audit-cms-'));
    const adapter = new RealCmsAdvisoryAdapter();
    const out = await adapter.exec({ ...BASE, workspaceDir: dir });
    expect(adapter.normalize(out)).toEqual([]);
  });
});
