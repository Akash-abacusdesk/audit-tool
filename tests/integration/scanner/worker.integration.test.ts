import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dockerAvailable, listWorkerContainers, listWorkerNetworks } from '@platform/worker-runtime';
import { runScan } from '../../../packages/scanner/src/index.js';
import { resolveImage } from '../../../packages/scanner/src/manifest.js';

// Real end-to-end validation against oscar's deliberately-vulnerable fixtures
// (build-plan L544-547): run image scanners through the isolated worker and
// assert normalized findings + teardown honesty. Gated off by default because
// it needs the docker engine + locally-built scanner images; enable in CI /
// the worker host with RUN_SCANNER_INTEGRATION=1.
const RUN = process.env.RUN_SCANNER_INTEGRATION === '1';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/repos/vuln-secrets', import.meta.url));

describe.skipIf(!RUN)('scanner integration through isolated workers', () => {
  it('engine + images available', async () => {
    expect(await dockerAvailable()).toBe(true);
  });

  for (const tool of ['semgrep', 'gitleaks', 'trivy'] as const) {
    it(`${tool} runs on vuln-secrets and normalizes findings`, async () => {
      const image = resolveImage(tool);
      if (!image) return; // image not built in this environment
      const env = await runScan({
        scanId: `itg-${tool}`,
        projectId: '11111111-1111-1111-1111-111111111111',
        tool,
        workspaceDir: FIXTURE,
        target: { kind: 'repo', ref: 'vuln-secrets', branch: 'main' },
      });
      expect(['completed', 'partial']).toContain(env.status);
      expect(env.findings.length).toBeGreaterThan(0);
    }, 120_000);
  }

  it('leaves no orphaned worker containers/networks (build-plan L548)', async () => {
    const ctr = await listWorkerContainers('com.platform.worker=true');
    const net = await listWorkerNetworks('com.platform.worker.net=true');
    expect(ctr).toHaveLength(0);
    expect(net).toHaveLength(0);
  });
});

void HERE;
