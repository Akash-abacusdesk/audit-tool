/**
 * Section-11 Safe Staging — D2 pg-boss job consumers. Registered once in
 * main.ts alongside the other real workers (deep-audit, update). Each handler
 * is idempotent enough for pg-boss redelivery: provisioning a staging id
 * that's already `ready` is a no-op re-mark, and destroy on missing
 * containers is a no-op (execDocker rm/network rm swallow "not found").
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  StagingDestroyPayload,
  StagingProvisionPayload,
  StagingTestRunPayload,
} from '@platform/shared';
import { provisionStagingContainers, destroyStagingContainers } from './provisioner.js';
import { runValidation } from './validate.js';
import { StagingOrchestrator, type StagingStore } from './queue.js';

export class StagingWorker {
  private readonly orchestrator: StagingOrchestrator;

  constructor(
    boss: { send(queue: string, data: unknown): Promise<string | null> },
    private readonly store: StagingStore
  ) {
    this.orchestrator = new StagingOrchestrator(boss, store);
  }

  async handleProvision(payload: StagingProvisionPayload): Promise<void> {
    const entry = await this.store.get(payload.stagingId);
    if (!entry) return; // deleted since enqueue — nothing to do
    if (entry.state === 'ready') return; // redelivered after success

    try {
      const runtime = await provisionStagingContainers(payload.stagingId);
      await this.store.setRuntime(payload.stagingId, runtime);
      await this.orchestrator.markProvisioned(payload.stagingId);
    } catch (err) {
      console.error('[staging] provision failed:', payload.stagingId, err instanceof Error ? err.message : err);
      await this.orchestrator.markProvisionFailed(payload.stagingId).catch(() => {});
    }
  }

  async handleTestRun(payload: StagingTestRunPayload): Promise<void> {
    const entry = await this.store.get(payload.stagingId);
    if (!entry?.runtime) {
      console.error('[staging] test-run: no runtime recorded for', payload.stagingId);
      return;
    }
    const outDir = await mkdtemp(path.join(tmpdir(), `staging-${payload.stagingId}-`));
    try {
      const result = await runValidation(payload.stagingId, payload.suite, entry.runtime, outDir);
      console.log('[staging] test-run', payload.stagingId, payload.suite, result.passed ? 'PASS' : 'FAIL', result.detail);
    } catch (err) {
      console.error('[staging] test-run error:', payload.stagingId, err instanceof Error ? err.message : err);
    } finally {
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async handleDestroy(payload: StagingDestroyPayload): Promise<void> {
    const entry = await this.store.get(payload.stagingId);
    if (entry?.runtime) {
      await destroyStagingContainers(entry.runtime).catch((err) =>
        console.error('[staging] destroy failed:', payload.stagingId, err instanceof Error ? err.message : err)
      );
    }
    await this.orchestrator.markDestroyed(payload.stagingId).catch(() => {});
  }
}
