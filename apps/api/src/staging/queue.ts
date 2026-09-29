/**
 * Section-11 Safe Staging — D1 pg-boss orchestration.
 *
 * Drives the staging lifecycle through pg-boss: STAGING_PROVISION builds the
 * ephemeral environment (D2's container lifecycle), STAGING_TEST_RUN runs a
 * validation suite, STAGING_DESTROY tears it down. The safety gate is consulted
 * before ANY test-run job is enqueued — a test run against an unsanitized or
 * not-ready staging is refused closed.
 */
import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import type { Queryable } from '../auth/audit.js';
import { asBossDb } from '../db/pool.js';
import {
  ApiError,
  assertStagingSafe,
  JOB,
  stagingDestroyPayload,
  stagingProvisionPayload,
  stagingTestRunPayload,
  transitionStaging,
  type StagingEvent,
  type StagingSafetyContext,
  type StagingState,
} from '@platform/shared';

export interface StagingRuntimeRecord {
  networkName: string;
  dbContainer: string;
  wpContainer: string;
  hostPort: number;
}

export interface StagingStoreEntry {
  id: string;
  projectId: string;
  environmentId: string;
  ref: string;
  state: StagingState;
  createdAt: string;
  runtime: StagingRuntimeRecord | null;
}

export interface StagingStore {
  create(projectId: string, environmentId: string, ref: string, db?: Queryable): Promise<string>;
  get(id: string, db?: Queryable): Promise<StagingStoreEntry | null>;
  /** Apply a lifecycle event to a known staging id; throws on unknown id/illegal transition. */
  apply(id: string, event: StagingEvent, db?: Queryable): Promise<StagingState>;
  /** Record which containers/network back this run (D2), so test-run/destroy can find them. */
  setRuntime(id: string, runtime: StagingRuntimeRecord): Promise<void>;
}

/** In-memory staging store — test/dev fallback. Production uses PgStagingStore (staging/pg-store.ts). */
export class InMemoryStagingStore implements StagingStore {
  private readonly runs = new Map<string, StagingStoreEntry>();

  async create(projectId: string, environmentId: string, ref: string): Promise<string> {
    const id = randomUUID();
    this.runs.set(id, {
      id,
      projectId,
      environmentId,
      ref,
      state: 'requested',
      createdAt: new Date().toISOString(),
      runtime: null,
    });
    return id;
  }

  async get(id: string): Promise<StagingStoreEntry | null> {
    return this.runs.get(id) ?? null;
  }

  async apply(id: string, event: StagingEvent): Promise<StagingState> {
    const e = this.runs.get(id);
    if (!e) throw new ApiError('NOT_FOUND', `staging ${id} not found`);
    e.state = transitionStaging(e.state, event);
    return e.state;
  }

  async setRuntime(id: string, runtime: StagingRuntimeRecord): Promise<void> {
    const e = this.runs.get(id);
    if (!e) throw new ApiError('NOT_FOUND', `staging ${id} not found`);
    e.runtime = runtime;
  }
}

/** Minimal boss surface the orchestrator needs — PgBoss satisfies this. */
export interface StagingBoss {
  send(queue: string, data: unknown, options?: { db: ReturnType<typeof asBossDb> }): Promise<string | null>;
}

export class StagingOrchestrator {
  constructor(
    private readonly boss: StagingBoss,
    private readonly store: StagingStore
  ) {}

  /** Begin provisioning an ephemeral staging environment. */
  async provision(
    projectId: string,
    environmentId: string,
    ref: string,
    db?: Queryable
  ): Promise<{ stagingId: string; jobId: string | null }> {
    // With `db` (a transaction) the row, its state change and the pg-boss job commit together: a crash can no
    // longer strand a run in `provisioning` with no job.
    const stagingId = await this.store.create(projectId, environmentId, ref, db);
    await this.store.apply(stagingId, 'provision', db); // requested -> provisioning
    const jobId = await this.boss.send(
      JOB.stagingProvision,
      stagingProvisionPayload.parse({ stagingId, projectId, environmentId, ref }),
      db ? { db: asBossDb(db) } : undefined
    );
    return { stagingId, jobId };
  }

  /**
   * Enqueue a validation/test run. The safety gate is consulted HERE — a test run
   * may only start against a ready staging whose PII/integrations/noindex gate passes.
   */
  async requestTestRun(
    stagingId: string,
    suite: 'smoke' | 'functional' | 'visual',
    safety: StagingSafetyContext
  ): Promise<{ jobId: string | null }> {
    const entry = await this.store.get(stagingId);
    if (!entry) throw new ApiError('NOT_FOUND', `staging ${stagingId} not found`);
    if (entry.state !== 'ready') {
      throw new ApiError('FORBIDDEN', `staging ${stagingId} is not ready (state=${entry.state})`);
    }
    assertStagingSafe(safety);
    const jobId = await this.boss.send(
      JOB.stagingTestRun,
      stagingTestRunPayload.parse({ stagingId, suite })
    );
    return { jobId };
  }

  /** Tear down the staging environment. */
  async destroy(stagingId: string, db?: Queryable): Promise<{ jobId: string | null }> {
    const entry = await this.store.get(stagingId, db);
    if (!entry) throw new ApiError('NOT_FOUND', `staging ${stagingId} not found`);
    await this.store.apply(stagingId, 'destroy', db); // ready -> destroying
    const jobId = await this.boss.send(
      JOB.stagingDestroy,
      stagingDestroyPayload.parse({ stagingId }),
      db ? { db: asBossDb(db) } : undefined
    );
    return { jobId };
  }

  // Called by the provision worker on outcome.
  async markProvisioned(stagingId: string): Promise<StagingState> {
    return this.store.apply(stagingId, 'provisioned');
  }
  async markProvisionFailed(stagingId: string): Promise<StagingState> {
    return this.store.apply(stagingId, 'provision_failed');
  }
  async markDestroyed(stagingId: string): Promise<StagingState> {
    return this.store.apply(stagingId, 'destroyed');
  }
}
