/**
 * Section-13 Safe WP Update Engine — pg-boss job consumers for the three
 * events that trigger real work (update-state.ts). The state machine already
 * transitions synchronously when the API accepts the event (queue.ts); these
 * jobs perform the actual side effect and, for `stage`, report the
 * validation outcome back (staging_passed/staging_failed) once it's known.
 *
 * There is no persistent production WordPress host wired into this
 * checkout (that integration is Phase 3 — see docs/ops/phase3-readiness.md),
 * so restore-point capture and production promotion have nothing real to act
 * on yet; they fail closed with a clear log instead of faking success. `stage`
 * has a real target: it stands up the same disposable environment S11 uses
 * and runs an actual functional check against it.
 */
import type { UpdatePromotePayload, UpdateSnapshotPayload, UpdateStagePayload } from '@platform/shared';
import { provisionStagingContainers, destroyStagingContainers } from '../staging/provisioner.js';
import { runValidation } from '../staging/validate.js';
import { UpdateOrchestrator, type UpdateStore } from './queue.js';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class UpdateWorker {
  private readonly orchestrator: UpdateOrchestrator;

  constructor(
    boss: { send(queue: string, data: unknown): Promise<string | null> },
    private readonly store: UpdateStore
  ) {
    this.orchestrator = new UpdateOrchestrator(boss, store);
  }

  async handleSnapshot(payload: UpdateSnapshotPayload): Promise<void> {
    console.log(
      `[update] snapshot ${payload.updateUnitId}: no production WP host configured for ` +
        `project ${payload.projectId}/env ${payload.environmentId} — restore-point capture is a Phase 3 dependency, skipped.`
    );
  }

  /** Real work: provisions a disposable environment for this update's target ref and functionally validates it. */
  async handleStage(payload: UpdateStagePayload): Promise<void> {
    const runId = `upd-${payload.updateUnitId}`;
    let runtime;
    try {
      runtime = await provisionStagingContainers(runId);
    } catch (err) {
      console.error('[update] stage: provisioning failed', payload.updateUnitId, err instanceof Error ? err.message : err);
      await this.orchestrator.transition(payload.updateUnitId, 'staging_failed').catch(() => {});
      return;
    }
    const outDir = await mkdtemp(path.join(tmpdir(), `update-${payload.updateUnitId}-`));
    try {
      const result = await runValidation(runId, 'functional', runtime, outDir);
      await this.orchestrator.transition(payload.updateUnitId, result.passed ? 'staging_passed' : 'staging_failed');
      console.log('[update] stage', payload.updateUnitId, result.passed ? 'PASS' : 'FAIL', result.detail);
    } catch (err) {
      console.error('[update] stage: validation failed', payload.updateUnitId, err instanceof Error ? err.message : err);
      await this.orchestrator.transition(payload.updateUnitId, 'staging_failed').catch(() => {});
    } finally {
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
      await destroyStagingContainers(runtime).catch(() => {});
    }
  }

  async handlePromote(payload: UpdatePromotePayload): Promise<void> {
    console.log(
      `[update] promote ${payload.updateUnitId}: no production WP host configured — ` +
        `production promotion is a Phase 3 dependency, skipped.`
    );
  }
}
