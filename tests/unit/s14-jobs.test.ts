import { describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { DeepAuditQueue } from '../../apps/api/src/deep-audit/queue.js';
import { DEEP_AUDIT_STAGES } from '@platform/shared';

describe('S14-D3 scanner pg-boss job dispatch order', () => {
  it('enqueues the 7 stages IN ORDER onto the queue', async () => {
    const sent: unknown[] = [];
    const boss = {
      send: vi.fn(async (_q: string, data: unknown) => {
        sent.push(data);
        return `job-${sent.length}`;
      }),
    } as unknown as PgBoss;

    const queue = new DeepAuditQueue(boss);
    const target = {
      projectId: '11111111-1111-4111-8111-111111111111',
      environmentId: '22222222-2222-4222-8222-222222222222',
      environment: 'staging',
      ref: 'main',
      isolatedEnv: true,
    };
    const ids = await queue.enqueuePipeline('audit-q', target as any);

    expect(ids.length).toBe(7);
    expect(sent.map((d: any) => d.stage)).toEqual([...DEEP_AUDIT_STAGES]);
    // each job carries the same auditId so a single pipeline is reconstructable
    expect(sent.every((d: any) => d.auditId === 'audit-q')).toBe(true);
    expect(queue.constructor === DeepAuditQueue).toBe(true);
  });

  it('dispatchOrder() mirrors DEEP_AUDIT_STAGES', () => {
    expect([...DeepAuditQueue.dispatchOrder()]).toEqual([...DEEP_AUDIT_STAGES]);
  });
});
