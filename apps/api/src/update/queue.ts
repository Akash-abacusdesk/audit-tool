/**
 * Section-13 Safe WordPress Update Engine — D1 orchestration.
 *
 * Drives one update unit (a single plugin/theme/core version bump) through
 * update-state.ts's transitions. Three events trigger real work and enqueue a
 * pg-boss job: `snapshot` (take a restore point), `stage` (begin staging
 * validation — gated on S11 staging readiness), and `promote` (execute the
 * production update). Every other event (staging/functional/visual pass or
 * fail, approve, reject, recovered) is a pure state transition, reported back
 * by a human approval or a validator/worker — no job to enqueue.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../auth/audit.js';
import { asBossDb } from '../db/pool.js';
import {
  ApiError,
  JOB,
  transitionUpdate,
  updatePromotePayload,
  updateSnapshotPayload,
  updateStagePayload,
  type TransitionContext,
  type UpdateEvent,
  type UpdateState,
} from '@platform/shared';

export interface UpdateUnitEntry {
  id: string;
  projectId: string;
  environmentId: string;
  component: string;
  fromVersion: string;
  toVersion: string;
  state: UpdateState;
  createdAt: string;
}

export interface UpdateStore {
  create(
    projectId: string,
    environmentId: string,
    component: string,
    fromVersion: string,
    toVersion: string,
    db?: Queryable
  ): Promise<string>;
  get(id: string, db?: Queryable): Promise<UpdateUnitEntry | null>;
  /** Apply a lifecycle event to a known update unit; throws on unknown id/illegal transition. */
  apply(id: string, event: UpdateEvent, ctx?: TransitionContext, db?: Queryable): Promise<UpdateState>;
}

/** In-memory update-unit store — test/dev fallback. Production uses PgUpdateStore (update/pg-store.ts). */
export class InMemoryUpdateStore implements UpdateStore {
  private readonly units = new Map<string, UpdateUnitEntry>();

  async create(
    projectId: string,
    environmentId: string,
    component: string,
    fromVersion: string,
    toVersion: string
  ): Promise<string> {
    const id = randomUUID();
    this.units.set(id, {
      id,
      projectId,
      environmentId,
      component,
      fromVersion,
      toVersion,
      state: 'discovered',
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async get(id: string): Promise<UpdateUnitEntry | null> {
    return this.units.get(id) ?? null;
  }

  async apply(id: string, event: UpdateEvent, ctx?: TransitionContext): Promise<UpdateState> {
    const u = this.units.get(id);
    if (!u) throw new ApiError('NOT_FOUND', `update unit ${id} not found`);
    u.state = transitionUpdate(u.state, event, ctx);
    return u.state;
  }
}

/** Minimal boss surface the orchestrator needs — PgBoss satisfies this. */
export interface UpdateBoss {
  send(queue: string, data: unknown, options?: { db: ReturnType<typeof asBossDb> }): Promise<string | null>;
}

/** Events that trigger real work and which queue they enqueue to. */
const JOB_FOR_EVENT: Partial<Record<UpdateEvent, string>> = {
  snapshot: JOB.updateSnapshot,
  stage: JOB.updateStage,
  promote: JOB.updatePromote,
};

export class UpdateOrchestrator {
  constructor(
    private readonly boss: UpdateBoss,
    private readonly store: UpdateStore
  ) {}

  async create(
    projectId: string,
    environmentId: string,
    component: string,
    fromVersion: string,
    toVersion: string,
    db?: Queryable
  ): Promise<string> {
    return this.store.create(projectId, environmentId, component, fromVersion, toVersion, db);
  }

  async get(id: string, db?: Queryable): Promise<UpdateUnitEntry | null> {
    return this.store.get(id, db);
  }

  /**
   * Apply one lifecycle event. If the event is snapshot/stage/promote, the
   * corresponding job is enqueued only after the state machine accepts the
   * transition — an illegal transition never reaches pg-boss.
   */
  async transition(
    id: string,
    event: UpdateEvent,
    ctx?: TransitionContext,
    db?: Queryable
  ): Promise<{ state: UpdateState; jobId: string | null }> {
    // With `db` (a transaction) the state change and its job commit together (no stranded unit on a crash).
    const entry = await this.store.get(id, db);
    if (!entry) throw new ApiError('NOT_FOUND', `update unit ${id} not found`);
    const state = await this.store.apply(id, event, ctx, db);

    const queue = JOB_FOR_EVENT[event];
    if (!queue) return { state, jobId: null };

    const payload =
      event === 'snapshot'
        ? updateSnapshotPayload.parse({ updateUnitId: id, projectId: entry.projectId, environmentId: entry.environmentId })
        : event === 'stage'
          ? updateStagePayload.parse({ updateUnitId: id })
          : updatePromotePayload.parse({ updateUnitId: id });
    const jobId = await this.boss.send(queue, payload, db ? { db: asBossDb(db) } : undefined);
    return { state, jobId };
  }
}
