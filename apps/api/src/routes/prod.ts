import type { FastifyInstance } from 'fastify';
import { executeCommand, ProdCommandRejectedError, type ProdExecResult } from '@platform/prodctl';
import { ApiError } from '@platform/shared';
import { assertScope, requirePermission } from '../auth/service.js';
import { recordAudit } from '../auth/audit.js';
import { createProdApproval, prodApprovalVerifier } from '../prod/approvals.js';
import {
  PROD_CONTROL_PERMISSION,
  prodActionInput,
  prodApprovalRequest,
  authorizeProdAction,
  recordProdAudit,
} from '../prod/control.js';

/**
 * S7-D1 wrapper around Dwight's restricted prod command service (S7-D2).
 * Every call is gated by `prod.execute` (coarse, in preHandler), re-checked at
 * the exact target scope, requires a correlated approval, and emits an audit
 * event carrying the requestId + approvalId. The allow-list / exec boundary
 * itself lives in @platform/prodctl — this route only adds authz + audit.
 */
export async function prodRoutes(app: FastifyInstance): Promise<void> {
  // Step 1 of 2: record an approval bound to this exact op/target/scope. Step 2 (/prod/commands) consumes it once.
  app.post('/prod/approvals', { preHandler: requirePermission(PROD_CONTROL_PERMISSION) }, async (req, reply) => {
    const parsed = prodApprovalRequest.safeParse(req.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'invalid approval request', parsed.error.flatten());
    const actor = req.actor!;
    await assertScope(req, parsed.data.scope, `prod.approval.${parsed.data.op}`, PROD_CONTROL_PERMISSION);
    const created = await createProdApproval(req.server.pool, actor.user.id, parsed.data);
    await recordAudit(req.server.pool, {
      actorId: actor.user.id,
      action: 'prod.approval.create',
      result: 'allow',
      orgId: parsed.data.scope.orgId,
      projectId: parsed.data.scope.projectId ?? null,
      environmentId: parsed.data.scope.environmentId ?? null,
      resource: `${parsed.data.op}:${parsed.data.target}`,
      requestId: req.id,
      details: { approvalId: created.approvalId },
    });
    return reply.code(201).send(created);
  });

  app.post(
    '/prod/commands',
    { preHandler: requirePermission(PROD_CONTROL_PERMISSION) },
    async (req, reply) => {
      const parsed = prodActionInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid prod action', parsed.error.flatten());
      }
      const input = parsed.data;
      const actor = req.actor!;
      const auth = await authorizeProdAction(actor, req.id, input, req.server.pool, {
        verifyApproval: prodApprovalVerifier(req.server.pool),
      });

      try {
        const result: ProdExecResult = await executeCommand({ op: input.op, target: input.target });
        await recordProdAudit(req.server.pool, {
          actorId: auth.actorId,
          action: `prod.${input.op}`,
          result: 'allow',
          scope: input.scope,
          approvalId: auth.approvalId,
          requestId: auth.requestId,
          resource: `${input.op}:${input.target}`,
        });
        return reply.code(200).send({
          op: result.op,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        const rejected = err?.name === 'ProdCommandRejectedError';
        await recordProdAudit(req.server.pool, {
          actorId: auth.actorId,
          action: `prod.${input.op}`,
          result: rejected ? 'deny' : 'error',
          scope: input.scope,
          approvalId: auth.approvalId,
          requestId: auth.requestId,
          resource: `${input.op}:${input.target}`,
          deniedReason: rejected ? err?.message : undefined,
        });
        if (rejected) {
          return reply.code(422).send({ error: err?.message });
        }
        throw e;
      }
    }
  );
}
