/**
 * Section-13 Safe WP Update Engine — pg-boss job consumers for the three
 * events that trigger real work (update-state.ts). The state machine already
 * transitions synchronously when the API accepts the event (queue.ts); these
 * jobs perform the actual side effect and, for `stage`, report the
 * validation outcome back (staging_passed/staging_failed) once it's known.
 *
 * There is no real production WordPress host wired into this checkout yet
 * (that integration is Phase 3 — see docs/ops/phase3-readiness.md). Until
 * then, snapshot/promote act against a long-lived docker stand-in
 * (production.ts) — real mysqldump/tar restore points, real wp-cli
 * promotions — so the whole code path is real and testable end-to-end; only
 * the target host is not the real thing. `stage` has always had a real
 * target: it stands up the same disposable environment S11 uses and runs an
 * actual functional check against it.
 */
import type { UpdatePromotePayload, UpdateSnapshotPayload, UpdateStagePayload } from '@platform/shared';
import { provisionStagingContainers, destroyStagingContainers } from '../staging/provisioner.js';
import { runValidation } from '../staging/validate.js';
import { takeSnapshot, promoteUpdate } from './production.js';
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
    try {
      const snap = await takeSnapshot(payload.environmentId, payload.updateUnitId);
      console.log('[update] snapshot', payload.updateUnitId, 'restore point captured:', snap.dbDumpPath, snap.contentTarPath);
    } catch (err) {
      console.error('[update] snapshot failed', payload.updateUnitId, err instanceof Error ? err.message : err);
    }
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
    const entry = await this.store.get(payload.updateUnitId);
    if (!entry) {
      console.error('[update] promote: unit not found', payload.updateUnitId);
      return;
    }
    try {
      const result = await promoteUpdate(entry.environmentId, entry.component, entry.toVersion);
      console.log('[update] promote', payload.updateUnitId, result.ok ? 'PASS' : 'FAIL', result.detail);
      if (!result.ok) {
        // 'promote' already advanced the unit to 'promoted' synchronously when the
        // API accepted the event (queue.ts) — there's no 'promoting' state left to
        // fail out of, so this is best-effort; the failure is still logged either way.
        await this.orchestrator.transition(payload.updateUnitId, 'promote_failed').catch(() => {});
      }
    } catch (err) {
      console.error('[update] promote failed', payload.updateUnitId, err instanceof Error ? err.message : err);
      await this.orchestrator.transition(payload.updateUnitId, 'promote_failed').catch(() => {});
    }
  }
}
