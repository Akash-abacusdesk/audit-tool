import type { FastifyInstance } from 'fastify';
import { executeCommand, ProdCommandRejectedError, type ProdExecResult } from '@platform/prodctl';
import { ApiError } from '@platform/shared';
import { requirePermission } from '../auth/service.js';
import {
  PROD_CONTROL_PERMISSION,
  prodActionInput,
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
      const auth = await authorizeProdAction(actor, req.id, input, req.server.pool);

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
