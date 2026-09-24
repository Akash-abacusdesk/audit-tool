import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import {
  buildDeepAuditReport,
  createMockAdapters,
  DeepAuditOrchestrator,
  type DeepAuditReport,
  type DeepAuditRunState,
  type DeepAuditStage,
  type DeepAuditStageAdapter,
  type DeepAuditTarget,
  DEEP_AUDIT_STAGES,
} from '@platform/shared';
import {
  RealCodeSastAdapter,
  RealCmsAdvisoryAdapter,
  RealHostLynisAdapter,
  RealTlsNetworkAdapter,
  RealStagingZapAdapter,
  RealArtifactMalwareAdapter,
} from './real-adapters.js';

/** Live adapter set: all 7 stages real (normalize itself has no live-tool version — the mock's dedup/prioritization logic IS the real logic). */
function liveAdapters(): Record<DeepAuditStage, DeepAuditStageAdapter> {
  return {
    ...createMockAdapters(),
    'code-sast': new RealCodeSastAdapter(),
    'cms-advisory': new RealCmsAdvisoryAdapter(),
    'host-lynis': new RealHostLynisAdapter(),
    'tls-network': new RealTlsNetworkAdapter(),
    'staging-zap': new RealStagingZapAdapter(),
    'artifact-malware': new RealArtifactMalwareAdapter(),
  };
}

export interface DeepAuditStoreEntry {
  id: string;
  target: DeepAuditTarget;
  report: DeepAuditReport | null;
  state: DeepAuditRunState | null;
  createdAt: string;
}

export interface DeepAuditStore {
  create(target: DeepAuditTarget): Promise<string>;
  get(id: string): Promise<DeepAuditStoreEntry | null>;
  setResult(id: string, state: DeepAuditRunState): Promise<void>;
}

/** In-memory deep-audit run store — test/dev fallback. Production uses PgDeepAuditStore (deep-audit/pg-store.ts). */
export class InMemoryDeepAuditStore implements DeepAuditStore {
  private readonly runs = new Map<string, DeepAuditStoreEntry>();

  async create(target: DeepAuditTarget): Promise<string> {
    const id = randomUUID();
    this.runs.set(id, {
      id,
      target,
      report: null,
      state: null,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async get(id: string): Promise<DeepAuditStoreEntry | null> {
    return this.runs.get(id) ?? null;
  }

  async setResult(id: string, state: DeepAuditRunState): Promise<void> {
    const e = this.runs.get(id);
    if (!e) return;
    e.state = state;
    e.report = buildDeepAuditReport(state);
  }
}

/**
 * pg-boss wiring for the serialized pipeline (D1/D3). Each `deep-audit.stage`
 * job runs exactly ONE stage against the persisted run state, then enqueues
 * the next stage itself — true serialization (never more than one stage for
 * a given audit in flight) and crash-safe resume (pg-boss redelivers the
 * same in-flight job on worker death; `runStage` is idempotent on a stage
 * already marked `done`). Real tool execution is per-stage — `liveAdapters()`
 * uses live adapters where they exist (code-sast today), mock elsewhere.
 */
export class DeepAuditQueue {
  private readonly adapters: Record<DeepAuditStage, DeepAuditStageAdapter>;

  constructor(
    private readonly boss: PgBoss,
    private readonly store: DeepAuditStore,
    adapters?: Record<DeepAuditStage, DeepAuditStageAdapter>
  ) {
    this.adapters = adapters ?? liveAdapters();
  }

  /** The serialized order the pipeline MUST dispatch in. */
  static dispatchOrder(): readonly DeepAuditStage[] {
    return DEEP_AUDIT_STAGES;
  }

  /** Enqueue ONLY the first stage; each stage chains to the next on completion. */
  async enqueuePipeline(auditId: string, target: DeepAuditTarget): Promise<string[]> {
    const first = DEEP_AUDIT_STAGES[0]!;
    const id = await this.boss.send('deep-audit.stage', { auditId, stage: first, target });
    if (!id) throw new Error(`failed to enqueue deep-audit stage: ${first}`);
    return [id];
  }

  /**
   * Runs exactly one stage, persists the updated state/report, and enqueues
   * the next stage (nothing to enqueue after the last).
   */
  async handleStageJob(payload: {
    auditId: string;
    stage: DeepAuditStage;
    target: DeepAuditTarget;
  }): Promise<{ stage: DeepAuditStage; done: boolean }> {
    const entry = await this.store.get(payload.auditId);
    if (!entry) throw new Error(`deep-audit run ${payload.auditId} not found`);

    const orch = new DeepAuditOrchestrator({ adapters: this.adapters });
    const state = entry.state ?? orch.initState(payload.auditId, payload.target);
    const i = DEEP_AUDIT_STAGES.indexOf(payload.stage);
    // Redelivery of an already-completed stage: runStage is a no-op, and the
    // next stage was already enqueued the first time — never enqueue twice.
    const alreadyDone = state.stages[i]!.status === 'done';
    const updated = await orch.runStage(state, payload.stage);
    await this.store.setResult(payload.auditId, updated);

    const isLast = i === DEEP_AUDIT_STAGES.length - 1;
    if (!isLast && !alreadyDone) {
      const next = DEEP_AUDIT_STAGES[i + 1]!;
      const nextId = await this.boss.send('deep-audit.stage', {
        auditId: payload.auditId,
        stage: next,
        target: payload.target,
      });
      if (!nextId) throw new Error(`failed to enqueue deep-audit stage: ${next}`);
    }
    return { stage: payload.stage, done: isLast };
  }
}
