import type { TelegramCallback } from '@platform/shared';
import type { Scheduler } from '../scheduler/scheduler.js';

/**
 * S9-D4: Telegram application-workflow integration. An *authorized, accepted*
 * callback (D1 has already done signature + fresh-RBAC + replay checks) is
 * fanned out here to the platform workflow it targets. This module is the
 * application side only — it never re-decides authorization and never emits
 * secrets. Four families map onto the D1 `TELEGRAM_OPS` set:
 *
 *   scan_trigger        -> scan_request  (enqueue a real scan job)
 *   deploy_approve/reject-> approval      (correlate to the change request id)
 *   restart_service/     -> task          (correlate to the target/task id)
 *   config_reload/status
 *   details.jit_request_id -> jit         (correlate to a Portal-initiated JIT
 *                                          request approved from Telegram)
 *
 * NOTE: D1's `TELEGRAM_OPS` has no dedicated `jit_*` action, so JIT is reached
 * by reference (a JIT request created in the Portal, then approved/triggered
 * from Telegram via `details.jit_request_id`). A dedicated `jit_request` op
 * would require extending the shared contract (D1-owned) — flagged to god.
 */
export interface TelegramWorkflowResult {
  action: TelegramCallback['action'];
  workflow: 'status' | 'scan_request' | 'approval' | 'task' | 'jit';
  status: 'reported' | 'queued' | 'acknowledged' | 'deferred' | 'duplicate';
  jobId?: string | null;
  classKey?: string;
  reason?: string;
  reference?: string | null;
  scheduler?: unknown;
}

function details(cb: TelegramCallback): Record<string, unknown> {
  return cb.details && typeof cb.details === 'object' && !Array.isArray(cb.details) ? cb.details : {};
}

function stringDetail(d: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = d[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function objectDetail(d: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = d[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export async function runTelegramWorkflow(
  cb: TelegramCallback,
  scheduler?: Scheduler,
): Promise<TelegramWorkflowResult> {
  const d = details(cb);

  // JIT workflow: a Portal-initiated JIT request referenced from Telegram.
  const jitRequestId = stringDetail(d, 'jit_request_id', 'jitRequestId');
  if (jitRequestId) {
    return {
      action: cb.action,
      workflow: 'jit',
      status: 'acknowledged',
      reference: jitRequestId,
    };
  }

  if (cb.action === 'status') {
    return {
      action: cb.action,
      workflow: 'status',
      status: 'reported',
      scheduler: scheduler ? await scheduler.telemetry() : null,
    };
  }

  if (cb.action === 'scan_trigger') {
    const classKey = stringDetail(d, 'classKey', 'class_key') ?? 'hardening_scan';
    if (!scheduler) {
      return { action: cb.action, workflow: 'scan_request', status: 'deferred', classKey, reason: 'scheduler_unavailable' };
    }
    if (!scheduler.hasClass(classKey)) {
      return { action: cb.action, workflow: 'scan_request', status: 'deferred', classKey, reason: 'unknown_class' };
    }
    const jobId = await scheduler.enqueue(classKey, objectDetail(d, 'payload'));
    return { action: cb.action, workflow: 'scan_request', status: 'queued', classKey, jobId };
  }

  if (cb.action === 'deploy_approve' || cb.action === 'deploy_reject') {
    return {
      action: cb.action,
      workflow: 'approval',
      status: 'acknowledged',
      reference: stringDetail(d, 'approvalId', 'approval_id', 'requestId', 'request_id') ?? cb.request_id ?? null,
    };
  }

  return {
    action: cb.action,
    workflow: 'task',
    status: 'acknowledged',
    reference: stringDetail(d, 'taskId', 'task_id', 'target') ?? cb.request_id ?? null,
  };
}

export function duplicateTelegramWorkflow(cb: TelegramCallback): TelegramWorkflowResult {
  const wf: TelegramWorkflowResult['workflow'] =
    cb.action === 'scan_trigger' ? 'scan_request' : 'task';
  return { action: cb.action, workflow: wf, status: 'duplicate' };
}
