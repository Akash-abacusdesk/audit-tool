import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerRunResult, WorkerRunSpec } from '@platform/worker-runtime';
import { runScan, ScannerNotAvailableError, ingestEnvelope, REGISTRY } from '../../../packages/scanner/src/index.js';

const SEMGREP_RAW = {
  results: [
    {
      check_id: 'rules/hardcoded-secret',
      path: 'src/leak.js',
      start: { line: 4 },
      extra: { message: 'Hardcoded secret', severity: 'ERROR' },
    },
  ],
};

// Fake worker: writes a semgrep artifact into the spec's /out dir, then returns completed.
const fakeWorker = (): ((s: WorkerRunSpec) => Promise<WorkerRunResult>) => {
  return async (spec) => {
    const outName = spec.cmd?.find((a) => a.startsWith('/out/'))?.replace('/out/', '') ?? 'out.json';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(spec.outDir!, outName), JSON.stringify(SEMGREP_RAW), 'utf8');
    return {
      runId: spec.runId,
      status: 'completed',
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      logsTail: '',
    };
  };
};

const baseReq = {
  scanId: 'scan-1',
  projectId: '11111111-1111-1111-1111-111111111111',
  tool: 'semgrep',
  workspaceDir: '/tmp/ws',
  target: { kind: 'repo' as const, ref: 'sha-abc', branch: 'main' },
};

describe('runScan (image worker dispatch)', () => {
  it('runs the scanner in an isolated worker and normalizes to an envelope', async () => {
    const env = await runScan(baseReq, { runWorkerJob: fakeWorker() });
    expect(env.scan_id).toBe('scan-1');
    expect(env.project_id).toBe(baseReq.projectId);
    expect(env.tool.name).toBe('semgrep');
    expect(env.tool.version).toBe('1.86.0'); // from scanner/tools.json
    expect(env.status).toBe('completed');
    expect(env.findings).toHaveLength(1);
    expect(env.findings[0].severity).toBe('high');
  });

  it('returns a failed envelope (no throw) and cleans /out on worker failure', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'scan-fail-'));
    const failingWorker = async (): Promise<WorkerRunResult> => ({
      runId: 'x',
      status: 'failed',
      exitCode: 2,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      logsTail: 'semgrep crashed',
    });
    const env = await runScan({ ...baseReq, outDir }, { runWorkerJob: failingWorker });
    expect(env.status).toBe('failed');
    expect(env.error_summary).toContain('semgrep crashed');
    await expect(stat(outDir)).rejects.toThrow(); // dir removed
  });

  it('throws ScannerNotAvailableError when the image is not packaged', async () => {
    await expect(runScan({ ...baseReq, tool: 'phpcs-wpcs' }, { runWorkerJob: fakeWorker() })).rejects.toBeInstanceOf(
      ScannerNotAvailableError,
    );
  });
});

describe('runScan (command dispatch)', () => {
  it('runs a package-manager audit via host exec and normalizes stdout', async () => {
    const npmRaw = {
      vulnerabilities: {
        lodash: {
          name: 'lodash',
          severity: 'high',
          via: [{ title: 'Prototype Pollution', url: 'https://npmjs.com/advisories/106', severity: 'high' }],
        },
      },
    };
    const env = await runScan(
      { ...baseReq, tool: 'npm-audit' },
      { execFile: async () => ({ stdout: JSON.stringify(npmRaw), stderr: '' }) },
    );
    expect(env.tool.name).toBe('npm-audit');
    expect(env.findings).toHaveLength(1);
    expect(env.findings[0].title).toContain('lodash');
  });
});

describe('ingestEnvelope', () => {
  it('POSTs the envelope to the sink with an idempotency key', async () => {
    const env = await runScan(baseReq, { runWorkerJob: fakeWorker() });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    await ingestEnvelope('https://api.example/', 'scan-1', env, 'key-xyz', { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/v1/scans/scan-1/findings');
    expect((init!.headers as Record<string, string>)['idempotency-key']).toBe('key-xyz');
    expect(JSON.parse(init!.body as string).scan_id).toBe('scan-1');
  });
});

describe('registry completeness', () => {
  it('registers every Section-5 scanner', () => {
    for (const t of ['semgrep', 'gitleaks', 'trivy', 'npm-audit', 'pnpm-audit', 'composer-audit', 'phpcs-wpcs', 'wp-vuln-intel']) {
      expect(REGISTRY[t]).toBeDefined();
    }
  });
});
