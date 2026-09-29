import { describe, expect, it, vi } from 'vitest';
import { JOB } from '@platform/shared';
import { startReconciler } from '../../apps/api/src/jobs/reconcile.js';

const ID = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';

describe('reconciler', () => {
  it('re-sends the job for runs stuck in an in-flight state', async () => {
    let handler: () => Promise<void> = async () => {};
    const send = vi.fn(async () => 'job');
    const boss = { createQueue: vi.fn(), schedule: vi.fn(), send, work: vi.fn(async (_q: string, ...rest: unknown[]) => { handler = rest[rest.length - 1] as () => Promise<void>; }) };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM api_staging_runs')) {
          return { rows: [{ id: ID, project_id: P, environment_id: E, ref: 'main', state: 'provisioning' }, { id: P, project_id: P, environment_id: E, ref: 'main', state: 'destroying' }] };
        }
        if (sql.includes('FROM api_update_units')) return { rows: [{ id: E, state: 'promoting' }, { id: ID, state: 'staging_validation' }] };
        return { rows: [] };
      }),
    };
    await startReconciler(boss as never, pool as never);
    await handler();
    expect(send.mock.calls.map((c) => c[0])).toEqual([JOB.stagingProvision, JOB.stagingDestroy, JOB.updatePromote, JOB.updateStage]);
  });
});
