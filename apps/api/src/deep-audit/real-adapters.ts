/**
 * Real (non-mock) deep-audit stage adapters. Ships alongside
 * `createMockAdapters()` (packages/shared/src/deep-audit.ts) and is swapped
 * in per-stage as live tool execution becomes available — see
 * DeepAuditQueue.handleStageJob.
 *
 * All 7 stages are real: code-sast (Semgrep+Gitleaks), cms-advisory (WP
 * inventory/advisory correlation), host-lynis, tls-network, staging-zap, and
 * artifact-malware (ClamAV) reuse @platform/scanner's registry/adapter/
 * worker-runtime path; normalize is the pipeline's own dedup/prioritization
 * and needs no live tool. Every container-based stage has been round-tripped
 * against a real Docker container this session (devsecops/scanner-{semgrep,
 * gitleaks,lynis,testssl,zap,clamav} — see scanner/build-record.json for
 * what was actually verified vs. just built). cms-advisory is a pure
 * in-process detector (no container).
 */
import {
  ApiError,
  type DeepAuditStageAdapter,
  type DeepAuditTarget,
  type RawStageOutput,
  type FindingInput,
} from '@platform/shared';
import { runScan, type ScanEnvelope } from '@platform/scanner';

function assertOk(tool: string, env: ScanEnvelope): FindingInput[] {
  if (env.status === 'failed') {
    throw new ApiError('INTERNAL', `${tool} failed during deep-audit code-sast: ${env.error_summary ?? 'unknown error'}`);
  }
  return env.findings;
}

export class RealCodeSastAdapter implements DeepAuditStageAdapter {
  readonly stage = 'code-sast' as const;
  readonly tool = 'semgrep+gitleaks';
  readonly heavy = false;

  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    if (!t.workspaceDir) {
      throw new ApiError('VALIDATION_ERROR', 'code-sast requires target.workspaceDir (a checked-out copy of ref)');
    }
    const target = { kind: 'repo' as const, ref: t.ref, branch: null };
    const [semgrep, gitleaks] = await Promise.all([
      runScan({ scanId: `deep-audit-${t.projectId}-semgrep`, projectId: t.projectId, environmentId: t.environmentId, tool: 'semgrep', workspaceDir: t.workspaceDir, target }),
      runScan({ scanId: `deep-audit-${t.projectId}-gitleaks`, projectId: t.projectId, environmentId: t.environmentId, tool: 'gitleaks', workspaceDir: t.workspaceDir, target }),
    ]);
    return {
      stage: this.stage,
      tool: this.tool,
      raw: {
        semgrep: assertOk('semgrep', semgrep),
        gitleaks: assertOk('gitleaks', gitleaks),
      },
    };
  }

  /** runScan already normalizes into FindingInput[] — this stage is a straight merge. */
  normalize(o: RawStageOutput): FindingInput[] {
    const r = o.raw as { semgrep: FindingInput[]; gitleaks: FindingInput[] };
    return [...r.semgrep, ...r.gitleaks];
  }
}

export class RealCmsAdvisoryAdapter implements DeepAuditStageAdapter {
  readonly stage = 'cms-advisory' as const;
  readonly tool = 'wp-vuln-intel';
  readonly heavy = false;

  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    if (!t.workspaceDir) {
      throw new ApiError('VALIDATION_ERROR', 'cms-advisory requires target.workspaceDir (containing the S10 WP inventory file)');
    }
    const target = { kind: 'repo' as const, ref: t.ref, branch: null };
    const env = await runScan({
      scanId: `deep-audit-${t.projectId}-wp-vuln-intel`,
      projectId: t.projectId,
      environmentId: t.environmentId,
      tool: 'wp-vuln-intel',
      workspaceDir: t.workspaceDir,
      target,
    });
    return { stage: this.stage, tool: this.tool, raw: assertOk('wp-vuln-intel', env) };
  }

  normalize(o: RawStageOutput): FindingInput[] {
    return o.raw as FindingInput[];
  }
}

/** Single-tool stages: exec() runs the one tool via runScan, normalize() is a passthrough. */
abstract class SingleToolAdapter implements DeepAuditStageAdapter {
  abstract readonly stage: DeepAuditStageAdapter['stage'];
  abstract readonly tool: string;
  abstract readonly heavy: boolean;
  abstract exec(t: DeepAuditTarget): Promise<RawStageOutput>;

  normalize(o: RawStageOutput): FindingInput[] {
    return o.raw as FindingInput[];
  }
}

export class RealHostLynisAdapter extends SingleToolAdapter {
  readonly stage = 'host-lynis' as const;
  readonly tool = 'lynis';
  readonly heavy = true;

  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    if (!t.clonePath) {
      throw new ApiError('VALIDATION_ERROR', 'host-lynis requires target.clonePath (an approved clone/image root)');
    }
    const target = { kind: 'host-metadata' as const, ref: t.ref, branch: null };
    const env = await runScan({
      scanId: `deep-audit-${t.projectId}-lynis`,
      projectId: t.projectId,
      environmentId: t.environmentId,
      tool: 'lynis',
      workspaceDir: t.clonePath,
      target,
    });
    return { stage: this.stage, tool: this.tool, raw: assertOk('lynis', env) };
  }
}

export class RealTlsNetworkAdapter extends SingleToolAdapter {
  readonly stage = 'tls-network' as const;
  readonly tool = 'testssl.sh';
  readonly heavy = false;

  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    if (!t.targetUrl) {
      throw new ApiError('VALIDATION_ERROR', 'tls-network requires target.targetUrl');
    }
    const target = { kind: 'url' as const, ref: t.ref, branch: null };
    const env = await runScan({
      scanId: `deep-audit-${t.projectId}-testssl`,
      projectId: t.projectId,
      environmentId: t.environmentId,
      tool: 'testssl.sh',
      targetUrl: t.targetUrl,
      target,
    });
    return { stage: this.stage, tool: this.tool, raw: assertOk('testssl.sh', env) };
  }
}

export class RealArtifactMalwareAdapter extends SingleToolAdapter {
  readonly stage = 'artifact-malware' as const;
  readonly tool = 'clamav';
  readonly heavy = true;

  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    if (!t.isolatedEnv) {
      throw new ApiError('FORBIDDEN', 'artifact-malware must run in an isolated sandbox (isolatedEnv=true)');
    }
    if (!t.workspaceDir) {
      throw new ApiError('VALIDATION_ERROR', 'artifact-malware requires target.workspaceDir (the artifact tree to scan)');
    }
    const target = { kind: 'artifact' as const, ref: t.ref, branch: null };
    const env = await runScan({
      scanId: `deep-audit-${t.projectId}-clamav`,
      projectId: t.projectId,
      environmentId: t.environmentId,
      tool: 'clamav',
      workspaceDir: t.workspaceDir,
      target,
    });
    return { stage: this.stage, tool: this.tool, raw: assertOk('clamav', env) };
  }
}

export class RealStagingZapAdapter extends SingleToolAdapter {
  readonly stage = 'staging-zap' as const;
  readonly tool = 'zap+playwright';
  readonly heavy = true;

  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    if (!t.isolatedEnv) {
      throw new ApiError('FORBIDDEN', 'staging-zap must run in an isolated sandbox (isolatedEnv=true)');
    }
    if (!t.targetUrl) {
      throw new ApiError('VALIDATION_ERROR', 'staging-zap requires target.targetUrl (a staging URL, never production)');
    }
    const target = { kind: 'url' as const, ref: t.ref, branch: null };
    const env = await runScan({
      scanId: `deep-audit-${t.projectId}-zap`,
      projectId: t.projectId,
      environmentId: t.environmentId,
      tool: 'zap',
      targetUrl: t.targetUrl,
      target,
    });
    return { stage: this.stage, tool: this.tool, raw: assertOk('zap', env) };
  }
}
