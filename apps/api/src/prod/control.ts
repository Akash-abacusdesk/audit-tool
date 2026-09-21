/**
 * S7-D1: RBAC authorization + approval + request-ID/audit correlation for the
 * restricted production command service (S7-D2, @platform/prodctl).
 *
 * This module is the authz/audit *interface* the restricted prod command
 * service (S7-D2, @platform/prodctl) is wrapped with. It does NOT execute
 * commands itself; routes/prod.ts calls prodctl.executeCommand inside these
 * guards. Every permitted prod action must:
 *   1. be authorized under `prod.execute` at the exact target scope (enforced
 *      by assertScope, which audits denials),
 *   2. carry a correlated approval reference (approvalId),
 *   3. emit an audit record carrying the requestId + approvalId.
 */
import type { FastifyRequest } from 'fastify';
import type { Actor } from '../auth/service.js';
import { z } from 'zod';
import { ApiError } from '@platform/shared';
import type { Queryable } from '../auth/audit.js';
import { recordAudit } from '../auth/audit.js';
import { assertScope } from '../auth/service.js';

export const PROD_CONTROL_PERMISSION = 'prod.execute' as const;

/**
 * Ops the restricted service permits. Keep in sync with @platform/prodctl
 * PROD_ALLOW_LIST — prodctl owns the allow-list; this enum is the contract
 * surface Dwight's route validates against before invoking executeCommand.
 */
export const PROD_OPS = ['inventory', 'health', 'deploy', 'plugin-update', 'rollback'] as const;
export type ProdOp = (typeof PROD_OPS)[number];

export const prodActionInput = z.object({
  op: z.enum(PROD_OPS),
  target: z.string().min(1).max(200),
  scope: z.object({
    orgId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    environmentId: z.string().uuid().optional(),
  }),
  approvalId: z.string().min(1).max(128),
  approvalToken: z.string().max(256).optional(),
  requestId: z.string().max(128).optional(),
});
export type ProdActionInput = z.infer<typeof prodActionInput>;

/**
 * Optional approval verifier Dwight wires in once the approval store exists.
 * Receives the approval ref, the acting user, and the scope being targeted.
 */
export type VerifyApproval = (
  approvalId: string,
  actorId: string,
  scope: { orgId: string; projectId?: string | null; environmentId?: string | null }
) => Promise<void>;

/** Pure guard: every prod action must reference an approval. No approval →
 *  hard fail before any authorization or execution. */
export function requireApprovalRef(input: ProdActionInput): string {
  const id = input.approvalId?.trim();
  if (!id) {
    throw new ApiError('VALIDATION_ERROR', 'prod action requires an approval reference (approvalId)');
  }
  return id;
}

export interface ProdAuthorization {
  actorId: string;
  requestId: string;
  approvalId: string;
}

/**
 * Authorize a prod action at the exact scope under `prod.execute`, requiring a
 * correlated approval. On success returns the correlation triple (actor,
 * requestId, approvalId) the caller must carry into the audit record and pass
 * to prodctl. Scope denials are audited by assertScope.
 *
 * Takes the resolved actor + requestId + pool explicitly (no FastifyRequest)
 * so the orchestration is unit-testable; routes pass req.actor / req.id /
 * req.server.pool after requirePermission('prod.execute') has authenticated.
 */
export async function authorizeProdAction(
  actor: Actor,
  requestId: string,
  input: ProdActionInput,
  pool: Queryable,
  opts: { verifyApproval?: VerifyApproval } = {}
): Promise<ProdAuthorization> {
  const scopeReq = {
    actor,
    server: { pool },
    method: 'POST',
    url: '/prod/commands',
    id: requestId,
  } as unknown as FastifyRequest;
  await assertScope(scopeReq, input.scope, `prod.control.${input.op}`, PROD_CONTROL_PERMISSION);
  const approvalId = requireApprovalRef(input);
  if (opts.verifyApproval) {
    await opts.verifyApproval(approvalId, actor.user.id, input.scope);
  }
  const resolvedRequestId = input.requestId?.trim() || requestId;
  return { actorId: actor.user.id, requestId: resolvedRequestId, approvalId };
}

export interface ProdAuditInput {
  actorId: string;
  /** typically `prod.${op}` */
  action: string;
  result: 'allow' | 'deny' | 'error';
  scope: { orgId: string; projectId?: string | null; environmentId?: string | null };
  approvalId: string;
  requestId: string;
  resource?: string | null;
  deniedReason?: string;
}

/** Emit a prod-control audit event correlated to the approval + request. */
export async function recordProdAudit(db: Queryable, e: ProdAuditInput): Promise<void> {
  await recordAudit(db, {
    actorId: e.actorId,
    action: 'prod.action',
    result: e.result,
    orgId: e.scope.orgId,
    projectId: e.scope.projectId ?? null,
    environmentId: e.scope.environmentId ?? null,
    resource: e.resource ?? null,
    requestId: e.requestId,
    details: { approvalId: e.approvalId, op: e.action, deniedReason: e.deniedReason },
  });
}
