import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../apps/api/src/scheduler/scheduler.js';
import { InMemoryRemediationStore } from '../../apps/api/src/ai-remediation/store.js';
import type { AiRemediationProvider } from '@platform/shared';

const PAYLOAD = {
  requestId: '11111111-1111-4111-8111-111111111111',
  findingId: '22222222-2222-4222-8222-222222222222',
  findingSummary: 'Hardcoded secret',
  codeContext: 'const x = 1;',
};

function makeScheduler(aiProvider: AiRemediationProvider | null, store = new InMemoryRemediationStore()) {
  const boss = {} as any;
  const pool = {} as any;
  const scheduler = new Scheduler({ boss, pool, aiProvider, remediationStore: store });
  return { scheduler, store };
}

describe('S20-D1 Scheduler ai_remediation dispatch (previously nonexistent)', () => {
  it('fails closed with no provider configured — marks the request failed, never a silent no-op', async () => {
    const { scheduler, store } = makeScheduler(null);
    const id = await store.create(PAYLOAD.findingId, 'p1', null, 'u1');
    await expect((scheduler as any).runAiRemediationJob({ ...PAYLOAD, requestId: id })).rejects.toThrow(
      /no AI provider is configured/
    );
    const entry = await store.get(id);
    expect(entry!.status).toBe('failed');
    expect(entry!.error).toMatch(/no AI provider is configured/);
  });

  it('calls the provider and persists a completed result', async () => {
    const provider: AiRemediationProvider = {
      generatePatch: vi.fn(async (input) => {
        expect(input.findingId).toBe(PAYLOAD.findingId);
        return { patch: '--- a\n+++ b', explanation: 'fix it', testGuidance: 'run tests', provider: 'anthropic', model: 'claude-x' };
      }),
    };
    const { scheduler, store } = makeScheduler(provider);
    const id = await store.create(PAYLOAD.findingId, 'p1', null, 'u1');
    await (scheduler as any).runAiRemediationJob({ ...PAYLOAD, requestId: id });
    const entry = await store.get(id);
    expect(entry!.status).toBe('completed');
    expect(entry!.patch).toBe('--- a\n+++ b');
    expect(entry!.explanation).toBe('fix it');
  });

  it('marks the request failed (not silently swallowed) when the provider throws', async () => {
    const provider: AiRemediationProvider = {
      generatePatch: vi.fn(async () => {
        throw new Error('provider timeout');
      }),
    };
    const { scheduler, store } = makeScheduler(provider);
    const id = await store.create(PAYLOAD.findingId, 'p1', null, 'u1');
    await expect((scheduler as any).runAiRemediationJob({ ...PAYLOAD, requestId: id })).rejects.toThrow('provider timeout');
    const entry = await store.get(id);
    expect(entry!.status).toBe('failed');
    expect(entry!.error).toBe('provider timeout');
  });
});
