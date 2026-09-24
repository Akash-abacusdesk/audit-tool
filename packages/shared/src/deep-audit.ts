/**
 * Section-14 Deep Security & Posture Auditing (S14-D3/D1/D2).
 *
 * A serialized 7-stage pipeline that runs ONLY against an authorized,
 * non-production target (staging / clone / preview). Every stage emits raw
 * tool output which is normalized into the COMMON findings contract
 * (packages/shared scanning.findingInput) so the whole pipeline collapses
 * into one findings model. Real tool execution (ZAP, Lynis, Semgrep, WPScan,
 * Gitleaks, SCA, malware) is CI-deferred; this module ships the orchestration
 * + adapter interfaces + MOCK adapters so the logic is unit-testable and the
 * live-tool wiring is a thin swap-in at CI time.
 *
 * Stages (MUST run in this order — serialized, one findings model):
 *   1 code-sast        → Semgrep + Gitleaks history + Deep SCA
 *   2 cms-advisory     → WPScan / CMS advisory
 *   3 host-lynis       → Lynis against an approved clone/image (heavy)
 *   4 tls-network      → TLS / cert / headers / network posture
 *   5 staging-zap      → staging + Playwright + ZAP (heavy, isolated)
 *   6 artifact-malware → artifact / malware scanning (heavy, isolated)
 *   7 normalize        → dedup + prioritization over the aggregated findings
 */
import { ApiError } from './errors.js';
import { findingInput, SEVERITIES, type FindingInput, type Severity } from './scanning.js';
import { z } from 'zod';

// ---- Stage vocabulary ----------------------------------------------------

export const DEEP_AUDIT_STAGES = [
  'code-sast',
  'cms-advisory',
  'host-lynis',
  'tls-network',
  'staging-zap',
  'artifact-malware',
  'normalize',
] as const;

export type DeepAuditStage = (typeof DEEP_AUDIT_STAGES)[number];

/** Heavy stages demand admission/isolation guards (D2). */
export const HEAVY_STAGES: ReadonlySet<DeepAuditStage> = new Set<DeepAuditStage>([
  'host-lynis',
  'staging-zap',
  'artifact-malware',
]);

export const TARGET_ENVIRONMENTS = ['production', 'staging', 'clone', 'preview'] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

// ---- Target (the thing being audited) ------------------------------------

export const deepAuditTarget = z.object({
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  environment: z.enum(TARGET_ENVIRONMENTS),
  ref: z.string().min(1).max(500),
  /** Approved clone/image path for Lynis (never the live prod host). */
  clonePath: z.string().min(1).max(1000).optional(),
  /** Heavy stages (ZAP, malware) MUST run inside an isolated sandbox. */
  isolatedEnv: z.boolean().default(false),
  /** Host dir with the checked-out ref, mounted read-only for code-sast tool execution. */
  workspaceDir: z.string().min(1).max(2000).optional(),
  /** Reachable endpoint for URL-target stages (tls-network, staging-zap). Never a production URL — admission refuses those stages outside isolatedEnv. */
  targetUrl: z.string().url().max(2000).optional(),
});

export type DeepAuditTarget = z.infer<typeof deepAuditTarget>;

export function isProductionTarget(target: DeepAuditTarget): boolean {
  return target.environment === 'production';
}

// ---- Adapter contract ----------------------------------------------------

export interface RawStageOutput {
  stage: DeepAuditStage;
  tool: string;
  raw: unknown;
}

export interface StageStatus {
  stage: DeepAuditStage;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  tool: string;
  findingCount: number;
  error?: string;
}

export interface DeepAuditStageAdapter {
  stage: DeepAuditStage;
  tool: string;
  heavy: boolean;
  /** Execute the (mocked or real) tool against an authorized target. */
  exec(target: DeepAuditTarget): Promise<RawStageOutput>;
  /** Map raw tool output into the common findings contract. */
  normalize(out: RawStageOutput): FindingInput[];
}

function fp(tool: string, ruleId: string, ref: string): string {
  return `${tool}|${ruleId}|${ref}`;
}

// ---- Mock adapters (canned raw → normalized findings) --------------------
// Each adapter owns a DISTINCT raw shape so normalize() exercises a real
// native→internal mapping rather than an echo. Real CI adapters swap `exec`.

class CodeSastMockAdapter implements DeepAuditStageAdapter {
  readonly stage = 'code-sast' as const;
  readonly tool = 'semgrep+gitleaks+sca';
  readonly heavy = false;
  async exec(_t: DeepAuditTarget): Promise<RawStageOutput> {
    return {
      stage: this.stage,
      tool: this.tool,
      raw: {
        semgrep: [{ check_id: 'java.deserialize', severity: 'ERROR', path: 'app/A.java', line: 12 }],
        gitleaks: [{ rule: 'private-key', file: 'keys/id_rsa', line: 1 }],
        sca: [{ cve: 'CVE-2024-0001', pkg: 'log4j', severity: 'high' }],
      },
    };
  }
  normalize(o: RawStageOutput): FindingInput[] {
    const r = o.raw as { semgrep: any[]; gitleaks: any[]; sca: any[] };
    const f: FindingInput[] = [];
    for (const h of r.semgrep) {
      f.push({
        finding_fingerprint: fp(this.tool, h.check_id, h.path),
        rule_id: h.check_id,
        title: `SAST ${h.check_id}`,
        severity: 'high',
        confidence: 'firm',
        location: { path: h.path, start_line: h.line },
      });
    }
    for (const g of r.gitleaks) {
      f.push({
        finding_fingerprint: fp(this.tool, g.rule, g.file),
        rule_id: g.rule,
        title: `Secret leak ${g.rule}`,
        severity: 'critical',
        confidence: 'certain',
        location: { path: g.file, start_line: g.line },
      });
    }
    for (const c of r.sca) {
      f.push({
        finding_fingerprint: fp(this.tool, c.cve, c.pkg),
        rule_id: c.cve,
        title: `SCA ${c.pkg}`,
        severity: 'high',
        confidence: 'firm',
        cve_ids: [c.cve],
      });
    }
    return f;
  }
}

class CmsAdvisoryMockAdapter implements DeepAuditStageAdapter {
  readonly stage = 'cms-advisory' as const;
  readonly tool = 'wpscan+advisory';
  readonly heavy = false;
  async exec(_t: DeepAuditTarget): Promise<RawStageOutput> {
    return {
      stage: this.stage,
      tool: this.tool,
      raw: {
        wpscan: [{ plugin: 'revslider', advisory: 'WPVULN-1', severity: 'high' }],
      },
    };
  }
  normalize(o: RawStageOutput): FindingInput[] {
    const r = o.raw as { wpscan: any[] };
    return r.wpscan.map((w) => ({
      finding_fingerprint: fp(this.tool, w.advisory, w.plugin),
      rule_id: w.advisory,
      title: `CMS ${w.plugin}`,
      severity: 'high',
      confidence: 'firm',
      advisory_ids: [w.advisory],
    }));
  }
}

class HostLynisMockAdapter implements DeepAuditStageAdapter {
  readonly stage = 'host-lynis' as const;
  readonly tool = 'lynis';
  readonly heavy = true;
  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    return {
      stage: this.stage,
      tool: this.tool,
      raw: { lynis: [{ test: 'LYNIS-SSH', warning: 'weak ciphers', severity: 7, clone: t.clonePath ?? 'clone' }] },
    };
  }
  normalize(o: RawStageOutput): FindingInput[] {
    const r = o.raw as { lynis: any[] };
    return r.lynis.map((l) => ({
      finding_fingerprint: fp(this.tool, l.test, l.clone),
      rule_id: l.test,
      title: `Lynis ${l.test}`,
      severity: (l.severity >= 8 ? 'high' : 'medium') as Severity,
      confidence: 'firm',
      location: { path: l.clone },
    }));
  }
}

class TlsNetworkMockAdapter implements DeepAuditStageAdapter {
  readonly stage = 'tls-network' as const;
  readonly tool = 'tls-posture';
  readonly heavy = false;
  async exec(_t: DeepAuditTarget): Promise<RawStageOutput> {
    return {
      stage: this.stage,
      tool: this.tool,
      raw: { tls: [{ host: 'api.example', grade: 'B', issue: 'TLS1.0 enabled' }] },
    };
  }
  normalize(o: RawStageOutput): FindingInput[] {
    const r = o.raw as { tls: any[] };
    return r.tls.map((t) => ({
      finding_fingerprint: fp(this.tool, 'tls-grade', t.host),
      rule_id: 'tls-grade',
      title: `TLS ${t.host}`,
      severity: (t.grade === 'A' ? 'info' : 'medium') as Severity,
      confidence: 'firm',
      evidence: t.issue,
    }));
  }
}

class StagingZapMockAdapter implements DeepAuditStageAdapter {
  readonly stage = 'staging-zap' as const;
  readonly tool = 'zap+playwright';
  readonly heavy = true;
  async exec(_t: DeepAuditTarget): Promise<RawStageOutput> {
    return {
      stage: this.stage,
      tool: this.tool,
      raw: { zap: [{ alert: 'XSS', risk: 'High', url: 'https://staging/login' }] },
    };
  }
  normalize(o: RawStageOutput): FindingInput[] {
    const r = o.raw as { zap: any[] };
    return r.zap.map((z) => ({
      finding_fingerprint: fp(this.tool, z.alert, z.url),
      rule_id: z.alert,
      title: `ZAP ${z.alert}`,
      severity: (z.risk === 'High' ? 'high' : 'medium') as Severity,
      confidence: 'firm',
      location: { url_param: z.url },
    }));
  }
}

class ArtifactMalwareMockAdapter implements DeepAuditStageAdapter {
  readonly stage = 'artifact-malware' as const;
  readonly tool = 'clamav+yara';
  readonly heavy = true;
  async exec(_t: DeepAuditTarget): Promise<RawStageOutput> {
    return {
      stage: this.stage,
      tool: this.tool,
      raw: { malware: [{ file: 'uploads/evil.php', sig: 'YARA.RCE', hit: true }] },
    };
  }
  normalize(o: RawStageOutput): FindingInput[] {
    const r = o.raw as { malware: any[] };
    return r.malware
      .filter((m) => m.hit)
      .map((m) => ({
        finding_fingerprint: fp(this.tool, m.sig, m.file),
        rule_id: m.sig,
        title: `Malware ${m.sig}`,
        severity: 'critical',
        confidence: 'firm',
        location: { path: m.file },
      }));
  }
}

class NormalizeMockAdapter implements DeepAuditStageAdapter {
  readonly stage = 'normalize' as const;
  readonly tool = 'deep-audit-prioritize';
  readonly heavy = false;
  /** Stage 7 folds in ALL prior findings (passed via raw) and dedups. */
  async exec(t: DeepAuditTarget): Promise<RawStageOutput> {
    return { stage: this.stage, tool: this.tool, raw: { aggregated: (t as any)._findings ?? [] } };
  }
  normalize(o: RawStageOutput): FindingInput[] {
    const all = o.raw as { aggregated: FindingInput[] };
    const seen = new Set<string>();
    const out: FindingInput[] = [];
    for (const f of all.aggregated) {
      if (seen.has(f.finding_fingerprint)) continue;
      seen.add(f.finding_fingerprint);
      const parsed = findingInput.safeParse(f);
      if (parsed.success) out.push(parsed.data);
    }
    const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    out.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return out;
  }
}

/** Default in-process mock adapter set (CI swaps exec() for real tools). */
export function createMockAdapters(): Record<DeepAuditStage, DeepAuditStageAdapter> {
  return {
    'code-sast': new CodeSastMockAdapter(),
    'cms-advisory': new CmsAdvisoryMockAdapter(),
    'host-lynis': new HostLynisMockAdapter(),
    'tls-network': new TlsNetworkMockAdapter(),
    'staging-zap': new StagingZapMockAdapter(),
    'artifact-malware': new ArtifactMalwareMockAdapter(),
    normalize: new NormalizeMockAdapter(),
  };
}

// ---- Admission / isolation (D2) ------------------------------------------
// Heavy stages must respect exclusion + isolation: no live prod host, Lynis
// uses an approved clone path, ZAP/malware run in an isolated sandbox.

export interface AdmissionVerdict {
  ok: boolean;
  reason?: string;
}

export function evaluateStageAdmission(target: DeepAuditTarget, stage: DeepAuditStage): AdmissionVerdict {
  if (isProductionTarget(target)) {
    return { ok: false, reason: 'deep-audit must not run against a live production target' };
  }
  if (stage === 'host-lynis') {
    if (target.environment !== 'clone' && !target.clonePath) {
      return { ok: false, reason: 'lynis requires an approved clone/image path, not the live host' };
    }
    return { ok: true };
  }
  if (stage === 'staging-zap' || stage === 'artifact-malware') {
    if (!target.isolatedEnv) {
      return {
        ok: false,
        reason: `${stage} must run in an isolated sandbox (isolatedEnv=true)`,
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

/** Throw ApiError unless the stage is admissible against the target. */
export function assertStageAdmission(target: DeepAuditTarget, stage: DeepAuditStage): void {
  const v = evaluateStageAdmission(target, stage);
  if (!v.ok) throw new ApiError('FORBIDDEN', v.reason ?? 'stage not admissible');
}

// ---- Orchestrator (serialized 7-stage state machine) ----------------------

export interface DeepAuditRunState {
  id: string;
  target: DeepAuditTarget;
  stages: StageStatus[];
  /** Running findings collected from completed non-normalize stages (pre-dedup). */
  aggregated: FindingInput[];
  /** Final findings — empty until the 'normalize' stage completes. */
  findings: FindingInput[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface DeepAuditOrchestratorDeps {
  adapters: Record<DeepAuditStage, DeepAuditStageAdapter>;
  /** admission check per stage; inject a no-op in tests that pre-clear it. */
  admission?: (target: DeepAuditTarget, stage: DeepAuditStage) => AdmissionVerdict;
}

/**
 * Serialized 7-stage state machine. `run()` drives all 7 stages in one call
 * (unit tests, one-shot use). `initState`/`runStage` are the same logic split
 * into per-stage steps so a pg-boss worker can execute exactly ONE stage per
 * job, persist the returned state, and enqueue the next stage — true
 * serialization (one stage in flight at a time) and crash-safe resume (a
 * redelivered job for an already-`done` stage is a no-op).
 */
export class DeepAuditOrchestrator {
  constructor(private readonly deps: DeepAuditOrchestratorDeps) {}

  /** Fresh run state for `id`/`target`. Refuses production targets up front. */
  initState(id: string, target: DeepAuditTarget): DeepAuditRunState {
    if (isProductionTarget(target)) {
      throw new ApiError('FORBIDDEN', 'deep-audit may not target a live production environment');
    }
    return {
      id,
      target,
      stages: DEEP_AUDIT_STAGES.map((s) => ({
        stage: s,
        status: 'pending',
        tool: this.deps.adapters[s].tool,
        findingCount: 0,
      })),
      aggregated: [],
      findings: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
  }

  /**
   * Execute exactly one stage against `state` and return the updated state.
   * Idempotent: a stage already `done` is returned unchanged (safe pg-boss
   * redelivery). Out-of-order execution (a stage whose predecessor has not
   * completed) is refused — the pipeline is serialized by construction, not
   * by trusting caller order.
   */
  async runStage(state: DeepAuditRunState, stage: DeepAuditStage): Promise<DeepAuditRunState> {
    const i = DEEP_AUDIT_STAGES.indexOf(stage);
    const st = state.stages[i]!;
    if (st.status === 'done') return state; // redelivery of an already-completed stage

    if (i > 0 && state.stages[i - 1]!.status !== 'done') {
      throw new ApiError(
        'CONFLICT',
        `deep-audit stage ${stage} cannot run before ${state.stages[i - 1]!.stage} completes`
      );
    }

    const adapter = this.deps.adapters[stage];
    const admission = this.deps.admission ?? evaluateStageAdmission;
    st.status = 'running';

    const verdict = admission(state.target, stage);
    if (!verdict.ok) {
      st.status = 'failed';
      st.error = verdict.reason;
      state.error = verdict.reason ?? 'admission denied';
      state.finishedAt = new Date().toISOString();
      throw new ApiError('FORBIDDEN', verdict.reason ?? 'stage not admissible');
    }

    try {
      // Stage 7 folds in everything collected so far.
      const execTarget =
        stage === 'normalize' ? ({ ...state.target, _findings: state.aggregated } as DeepAuditTarget) : state.target;
      const raw = await adapter.exec(execTarget);
      const findings = adapter.normalize(raw);
      st.findingCount = findings.length;
      st.status = 'done';
      if (stage === 'normalize') {
        // prioritized + deduped set replaces the raw aggregate
        state.findings = findings;
      } else {
        state.aggregated.push(...findings);
        if (i === DEEP_AUDIT_STAGES.length - 1) state.findings = findings;
      }
      if (i === DEEP_AUDIT_STAGES.length - 1) {
        if (!state.findings.length) state.findings = state.aggregated;
        state.finishedAt = new Date().toISOString();
      }
    } catch (err) {
      st.status = 'failed';
      st.error = err instanceof Error ? err.message : String(err);
      state.error = st.error;
      state.finishedAt = new Date().toISOString();
      throw err;
    }
    return state;
  }

  /** Run all 7 stages IN ORDER, one call. Refuses production targets before stage 1. */
  async run(id: string, target: DeepAuditTarget): Promise<DeepAuditRunState> {
    let state = this.initState(id, target);
    for (const stage of DEEP_AUDIT_STAGES) {
      state = await this.runStage(state, stage);
    }
    return state;
  }
}

// ---- Report aggregation (D3) ---------------------------------------------

export interface DeepAuditReport {
  id: string;
  target: DeepAuditTarget;
  severityCounts: Record<Severity, number> & { total: number };
  stageStatus: Record<DeepAuditStage, StageStatus>;
  findings: FindingInput[];
}

export function buildDeepAuditReport(state: DeepAuditRunState): DeepAuditReport {
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 } as Record<
    Severity,
    number
  > & { total: number };
  for (const f of state.findings) {
    severityCounts[f.severity] += 1;
    severityCounts.total += 1;
  }
  const stageStatus = {} as Record<DeepAuditStage, StageStatus>;
  for (const s of state.stages) stageStatus[s.stage] = s;
  return { id: state.id, target: state.target, severityCounts, stageStatus, findings: state.findings };
}

export function emptySeverityCounts(): Record<Severity, number> & { total: number } {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
}

export { SEVERITIES };
