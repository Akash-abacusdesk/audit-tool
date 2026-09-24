import { describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { DeepAuditQueue, InMemoryDeepAuditStore } from '../../apps/api/src/deep-audit/queue.js';
import { createMockAdapters, DEEP_AUDIT_STAGES } from '@platform/shared';

const TARGET = {
  projectId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
  environment: 'staging' as const,
  ref: 'main',
  isolatedEnv: true,
  clonePath: '/clone/img',
};

function fakeBoss() {
  const sent: any[] = [];
  const boss = {
    send: vi.fn(async (_q: string, data: unknown) => {
      sent.push(data);
      return `job-${sent.length}`;
    }),
  } as unknown as PgBoss;
  return { boss, sent };
}

describe('S14-D3 scanner pg-boss job dispatch order', () => {
  it('enqueues ONLY the first stage — each stage chains to the next on completion', async () => {
    const { boss, sent } = fakeBoss();
    const store = new InMemoryDeepAuditStore();
    const queue = new DeepAuditQueue(boss, store);

    const ids = await queue.enqueuePipeline('audit-q', TARGET as any);

    expect(ids.length).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0].stage).toBe(DEEP_AUDIT_STAGES[0]);
    expect(sent[0].auditId).toBe('audit-q');
  });

  it('dispatchOrder() mirrors DEEP_AUDIT_STAGES', () => {
    expect([...DeepAuditQueue.dispatchOrder()]).toEqual([...DEEP_AUDIT_STAGES]);
  });
});

describe('S14-D3 handleStageJob: true per-stage execution + chaining', () => {
  it('runs exactly one stage per call and self-enqueues the next, in order, until the last', async () => {
    const { boss, sent } = fakeBoss();
    const store = new InMemoryDeepAuditStore();
    // Mock adapters throughout — this test exercises chaining/persistence, not tool execution.
    const queue = new DeepAuditQueue(boss, store, createMockAdapters());
    const auditId = await store.create(TARGET as any);

    let stage = DEEP_AUDIT_STAGES[0]!;
    const order: string[] = [];
    for (let i = 0; i < DEEP_AUDIT_STAGES.length; i++) {
      const result = await queue.handleStageJob({ auditId, stage, target: TARGET as any });
      order.push(stage);
      expect(result.done).toBe(i === DEEP_AUDIT_STAGES.length - 1);
      const entry = (await store.get(auditId))!;
      expect(entry.state!.stages[i]!.status).toBe('done');
      if (!result.done) {
        stage = sent[sent.length - 1].stage;
      }
    }

    expect(order).toEqual([...DEEP_AUDIT_STAGES]);
    // pipeline self-enqueued 6 follow-on jobs (not the 7th, which is terminal).
    expect(sent.length).toBe(DEEP_AUDIT_STAGES.length - 1);
    expect((await store.get(auditId))!.report).not.toBeNull();
  });

  it('is idempotent on redelivery of an already-completed stage (no duplicate enqueue)', async () => {
    const { boss, sent } = fakeBoss();
    const store = new InMemoryDeepAuditStore();
    const queue = new DeepAuditQueue(boss, store, createMockAdapters());
    const auditId = await store.create(TARGET as any);
    const first = DEEP_AUDIT_STAGES[0]!;

    await queue.handleStageJob({ auditId, stage: first, target: TARGET as any });
    expect(sent.length).toBe(1); // enqueued stage 2

    // Redeliver the same (now-done) first stage job — must be a no-op, not a second enqueue.
    await queue.handleStageJob({ auditId, stage: first, target: TARGET as any });
    expect(sent.length).toBe(1);
  });

  it('throws NOT_FOUND-shaped error for an unknown audit id', async () => {
    const { boss } = fakeBoss();
    const store = new InMemoryDeepAuditStore();
    const queue = new DeepAuditQueue(boss, store, createMockAdapters());
    await expect(
      queue.handleStageJob({ auditId: 'nope', stage: DEEP_AUDIT_STAGES[0]!, target: TARGET as any })
    ).rejects.toThrow(/not found/);
  });
});
