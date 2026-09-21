import { describe, expect, it } from 'vitest';
import type { TelegramCallback } from '../../packages/shared/src/index.js';
import { duplicateTelegramWorkflow, runTelegramWorkflow } from '../../apps/api/src/telegram/workflows.js';

const base = (action: TelegramCallback['action'], details?: Record<string, unknown>): TelegramCallback => ({
  bot_id: 'ops-bot',
  delivery_id: `delivery-${action}`,
  chat_id: 'chat-1',
  user_id: 'user-1',
  action,
  occurred_at: new Date().toISOString(),
  details,
});

describe('S9-D4 telegram application workflows', () => {
  it('reports status without needing scheduler', async () => {
    await expect(runTelegramWorkflow(base('status'))).resolves.toMatchObject({
      workflow: 'status',
      status: 'reported',
      scheduler: null,
    });
  });

  it('queues scan request through scheduler only', async () => {
    const calls: unknown[] = [];
    const scheduler = {
      hasClass: (key: string) => key === 'hardening_scan',
      enqueue: async (key: string, payload: object) => {
        calls.push({ key, payload });
        return 'job-1';
      },
    };

    const result = await runTelegramWorkflow(
      base('scan_trigger', { classKey: 'hardening_scan', payload: { kind: 'scan', tool: 'semgrep' } }),
      scheduler as any,
    );

    expect(result).toMatchObject({ workflow: 'scan_request', status: 'queued', classKey: 'hardening_scan', jobId: 'job-1' });
    expect(calls).toEqual([{ key: 'hardening_scan', payload: { kind: 'scan', tool: 'semgrep' } }]);
  });

  it('defers scan request when scheduler cannot accept it', async () => {
    await expect(runTelegramWorkflow(base('scan_trigger', { classKey: 'missing' }))).resolves.toMatchObject({
      workflow: 'scan_request',
      status: 'deferred',
      reason: 'scheduler_unavailable',
    });
  });

  it('routes a referenced JIT request to the jit workflow family', async () => {
    await expect(runTelegramWorkflow(base('deploy_approve', { jit_request_id: 'jit-9' }))).resolves.toMatchObject({
      workflow: 'jit',
      status: 'acknowledged',
      reference: 'jit-9',
    });
  });

  it('acknowledges approval and task callbacks without executing prod commands', async () => {
    await expect(runTelegramWorkflow(base('deploy_approve', { approval_id: 'ap-1' }))).resolves.toMatchObject({
      workflow: 'approval',
      status: 'acknowledged',
      reference: 'ap-1',
    });
    await expect(runTelegramWorkflow(base('restart_service', { target: 'wp-prod' }))).resolves.toMatchObject({
      workflow: 'task',
      status: 'acknowledged',
      reference: 'wp-prod',
    });
  });

  it('does not rerun workflow for duplicate callbacks', () => {
    expect(duplicateTelegramWorkflow(base('scan_trigger'))).toMatchObject({
      workflow: 'scan_request',
      status: 'duplicate',
    });
  });
});
