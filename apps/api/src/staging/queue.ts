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
import {
  ApiError,
  assertStagingSafe,
  JOB,
  stagingDestroyPayload,
  stagingProvisionPayload,
  stagingTestRunPayload,
  transitionStaging,
  type StagingSafetyContext,
  type StagingState,
} from '@platform/shared';

export interface StagingStoreEntry {
  id: string;
  projectId: string;
  environmentId: string;
  ref: string;
  state: StagingState;
  createdAt: string;
}

/** In-memory staging store (swap for PG when promotion past CI mocks). */
export class StagingStore {
  private readonly runs = new Map<string, StagingStoreEntry>();

  create(projectId: string, environmentId: string, ref: string): string {
    const id = randomUUID();
    this.runs.set(id, {
      id,
      projectId,
      environmentId,
      ref,
      state: 'requested',
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  get(id: string): StagingStoreEntry | null {
    return this.runs.get(id) ?? null;
  }

  /** Apply a lifecycle event to a known staging id; throws on unknown/idle state. */
  apply(id: string, event: Parameters<typeof transitionStaging>[1]): StagingState {
    const e = this.runs.get(id);
    if (!e) throw new ApiError('NOT_FOUND', `staging ${id} not found`);
    e.state = transitionStaging(e.state, event);
    return e.state;
  }
}

/** Minimal boss surface the orchestrator needs — PgBoss satisfies this. */
export interface StagingBoss {
  send(queue: string, data: unknown): Promise<string | null>;
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
    ref: string
  ): Promise<{ stagingId: string; jobId: string | null }> {
    const stagingId = this.store.create(projectId, environmentId, ref);
    this.store.apply(stagingId, 'provision'); // requested -> provisioning
    const jobId = await this.boss.send(
      JOB.stagingProvision,
      stagingProvisionPayload.parse({ stagingId, projectId, environmentId, ref })
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
    const entry = this.store.get(stagingId);
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
  async destroy(stagingId: string): Promise<{ jobId: string | null }> {
    const entry = this.store.get(stagingId);
    if (!entry) throw new ApiError('NOT_FOUND', `staging ${stagingId} not found`);
    this.store.apply(stagingId, 'destroy'); // ready -> destroying
    const jobId = await this.boss.send(
      JOB.stagingDestroy,
      stagingDestroyPayload.parse({ stagingId })
    );
    return { jobId };
  }

  // Called by the provision worker on outcome.
  markProvisioned(stagingId: string): StagingState {
    return this.store.apply(stagingId, 'provisioned');
  }
  markProvisionFailed(stagingId: string): StagingState {
    return this.store.apply(stagingId, 'provision_failed');
  }
  markDestroyed(stagingId: string): StagingState {
    return this.store.apply(stagingId, 'destroyed');
  }
}
