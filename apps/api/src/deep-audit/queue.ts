import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import {
  buildDeepAuditReport,
  createMockAdapters,
  DeepAuditOrchestrator,
  type DeepAuditReport,
  type DeepAuditRunState,
  type DeepAuditStage,
  type DeepAuditTarget,
  DEEP_AUDIT_STAGES,
} from '@platform/shared';

/**
 * In-memory deep-audit run store (D1 common persistence/state).
 * ponytail: swap for a PG table (api_deep_audit_runs) when the pipeline is
 * promoted past CI-deferred mock execution; the interface is the contract.
 */
export interface DeepAuditStoreEntry {
  id: string;
  target: DeepAuditTarget;
  report: DeepAuditReport | null;
  state: DeepAuditRunState | null;
  createdAt: string;
}

export class DeepAuditStore {
  private readonly runs = new Map<string, DeepAuditStoreEntry>();

  create(target: DeepAuditTarget): string {
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

  get(id: string): DeepAuditStoreEntry | null {
    return this.runs.get(id) ?? null;
  }

  setResult(id: string, state: DeepAuditRunState): void {
    const e = this.runs.get(id);
    if (!e) return;
    e.state = state;
    e.report = buildDeepAuditReport(state);
  }
}

/**
 * pg-boss wiring for the serialized pipeline (D3/D1). Real tool execution is
 * CI-deferred — `handleStageJob` runs the mock adapter set so the queue path
 * is exercisable; CI swaps `createMockAdapters()` for live tool adapters.
 */
export class DeepAuditQueue {
  constructor(private readonly boss: PgBoss) {}

  /** The serialized order the pipeline MUST dispatch in. */
  static dispatchOrder(): readonly DeepAuditStage[] {
    return DEEP_AUDIT_STAGES;
  }

  /** Enqueue all 7 stages IN ORDER. Returns the job ids in stage order. */
  async enqueuePipeline(auditId: string, target: DeepAuditTarget): Promise<string[]> {
    const ids: string[] = [];
    for (const stage of DEEP_AUDIT_STAGES) {
      const id = await this.boss.send('deep-audit.stage', { auditId, stage, target });
      if (!id) throw new Error(`failed to enqueue deep-audit stage: ${stage}`);
      ids.push(id);
    }
    return ids;
  }

  /** CI-deferred consumer: run one stage and return normalized findings. */
  async handleStageJob(payload: { auditId: string; stage: DeepAuditStage; target: DeepAuditTarget }): Promise<{
    stage: DeepAuditStage;
    findings: unknown[];
  }> {
    const orch = new DeepAuditOrchestrator({ adapters: createMockAdapters() });
    const state = await orch.run(payload.auditId, payload.target);
    return { stage: payload.stage, findings: state.findings };
  }
}
