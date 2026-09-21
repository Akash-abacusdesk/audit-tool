import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as cpExecFile } from 'node:child_process';
import {
  runWorkerJob,
  profileForTool,
  type WorkerRunSpec,
  type WorkerRunResult,
} from '@platform/worker-runtime';
import type { ScanEnvelope, FindingInput } from '@platform/shared';
import { REGISTRY } from './registry.js';
import { resolveImage, toolMeta } from './manifest.js';
import type { ScanRequest, AdapterContext } from './types.js';

const execFileP = promisify(cpExecFile);

export class ScannerNotAvailableError extends Error {
  constructor(tool: string) {
    super(`scanner not available: ${tool}`);
    this.name = 'ScannerNotAvailableError';
  }
}

export interface RunDeps {
  runWorkerJob?: (spec: WorkerRunSpec) => Promise<WorkerRunResult>;
  profileForTool?: (tool: string) => import('@platform/worker-runtime').ResourceLimits;
  resolveImage?: (tool: string) => string | null;
  execFile?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  now?: () => Date;
  /** keep the /out scratch dir after the run (debugging). */
  keepOutDir?: boolean;
}

/**
 * Run a scanner for a request and return a normalized SCANNING-CONVENTIONS §2
 * envelope. Image scanners are dispatched through the isolated worker runtime;
 * package-manager audits run via host exec. Either way the native output is
 * handed to the tool's adapter and shaped into `findingInput[]`.
 */
export async function runScan(req: ScanRequest, deps: RunDeps = {}): Promise<ScanEnvelope> {
  const def = REGISTRY[req.tool];
  if (!def) throw new ScannerNotAvailableError(req.tool);

  const runWorker = deps.runWorkerJob ?? runWorkerJob;
  const profileOf = deps.profileForTool ?? profileForTool;
  const resolve = deps.resolveImage ?? ((t: string) => resolveImage(t));
  const now = deps.now ?? (() => new Date());
  const meta = toolMeta(req.tool);

  const base: ScanEnvelope = {
    schema_version: '1.0',
    scan_id: req.scanId,
    project_id: req.projectId,
    environment_id: req.environmentId,
    tool: { name: req.tool, version: meta.version, image_digest: meta.imageDigest ?? undefined },
    target: { kind: req.target.kind, ref: req.target.ref, branch: req.target.branch ?? null },
    started_at: now().toISOString(),
    status: 'completed',
    error_summary: null,
    findings: [] as FindingInput[],
  };

  try {
    let raw: string;
    let finishedAt = now().toISOString();
    const ctx: AdapterContext = {
      tool: req.tool,
      target: { kind: req.target.kind, ref: req.target.ref, branch: req.target.branch ?? null },
    };

    if (def.invocation.kind === 'rules') {
      // Internal cross-stack detector: reads the workspace, emits findings directly.
      const findings = await def.invocation.detect(req.workspaceDir, ctx);
      return { ...base, finished_at: now().toISOString(), findings };
    }

    if (def.invocation.kind === 'image') {
      const image = resolve(req.tool);
      if (!image) throw new ScannerNotAvailableError(req.tool);
      const outDir = req.outDir ?? (await mkdtemp(join(tmpdir(), `scan-${req.tool}-`)));
      const spec: WorkerRunSpec = {
        runId: `scan-${req.scanId}-${req.tool}`,
        jobId: req.jobId,
        image,
        cmd: def.invocation.cmd(def.invocation.outFile, req.workspaceDir),
        workspaceDir: req.workspaceDir,
        outDir,
        limits: profileOf(req.tool),
        egress: def.invocation.egress ? { mode: def.invocation.egress } : { mode: 'offline' },
        extraScratch: def.invocation.extraScratch,
      };
      const res = await runWorker(spec);
      finishedAt = res.finishedAt;
      if (res.status === 'failed' || res.status === 'timedOut' || res.status === 'cancelled') {
        if (!deps.keepOutDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
        return {
          ...base,
          finished_at: finishedAt,
          status: res.status === 'failed' ? 'failed' : 'partial',
          error_summary: res.logsTail || `worker ${res.status}`,
        };
      }
      raw =
        def.invocation.readFrom === 'stdout'
          ? res.logsTail
          : await readFile(join(outDir, def.invocation.outFile), 'utf8');
      if (!deps.keepOutDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
    } else {
      const fallbackExec = (b: string, a: string[]): Promise<{ stdout: string; stderr: string }> =>
        execFileP(b, a, { cwd: req.workspaceDir, maxBuffer: 64 * 1024 * 1024 });
      const exec = deps.execFile ?? fallbackExec;
      const r = await exec(def.invocation.bin, def.invocation.args(req.workspaceDir));
      raw = r.stdout;
    }

    if (!def.adapter) throw new Error(`scanner ${req.tool} has no adapter`);
    const findings = def.adapter(JSON.parse(raw), {
      tool: req.tool,
      target: { kind: req.target.kind, ref: req.target.ref, branch: req.target.branch ?? null },
    });
    return { ...base, finished_at: finishedAt, findings };
  } catch (e) {
    if (e instanceof ScannerNotAvailableError) throw e;
    return {
      ...base,
      finished_at: now().toISOString(),
      status: 'failed',
      error_summary: String((e as Error)?.message ?? e),
    };
  }
}
