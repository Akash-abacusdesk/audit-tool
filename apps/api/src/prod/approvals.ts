import type { Pool } from 'pg';
import { ApiError, isUuid } from '@platform/shared';
import type { ProdActionInput, VerifyApproval } from './control.js';

const TTL_MIN = Number(process.env.PROD_APPROVAL_TTL_MIN ?? 10);

/** Record an approval bound to one op + target + scope; returns its id. */
export async function createProdApproval(
  pool: Pool,
  actorId: string,
  a: Pick<ProdActionInput, 'op' | 'target' | 'scope'>
): Promise<{ approvalId: string; expiresAt: string }> {
  const r = await pool.query<{ id: string; expires_at: Date }>(
    `INSERT INTO prod_approvals (op, target, org_id, project_id, environment_id, requested_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
     RETURNING id::text, expires_at`,
    [a.op, a.target, a.scope.orgId, a.scope.projectId ?? null, a.scope.environmentId ?? null, actorId, TTL_MIN]
  );
  return { approvalId: r.rows[0]!.id, expiresAt: r.rows[0]!.expires_at.toISOString() };
}

/**
 * Consume an approval atomically: it must exist, be unexpired, unused, and match the exact op/target/scope.
 * With PROD_REQUIRE_SECOND_APPROVER=true the executor must differ from the requester (four-eyes).
 */
export function prodApprovalVerifier(pool: Pool): VerifyApproval {
  return async (approvalId, actorId, scope, cmd) => {
    if (!isUuid(approvalId)) throw new ApiError('VALIDATION_ERROR', 'approvalId must be an id from POST /prod/approvals');
    const secondApprover = process.env.PROD_REQUIRE_SECOND_APPROVER === 'true';
    const r = await pool.query(
      `UPDATE prod_approvals SET consumed_at = now(), consumed_by = $2
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
          AND op = $3 AND target = $4 AND org_id = $5
          AND project_id IS NOT DISTINCT FROM $6 AND environment_id IS NOT DISTINCT FROM $7
          AND ($8::boolean = false OR requested_by <> $2)
        RETURNING id`,
      [approvalId, actorId, cmd.op, cmd.target, scope.orgId, scope.projectId ?? null, scope.environmentId ?? null, secondApprover]
    );
    if (r.rowCount !== 1) throw new ApiError('FORBIDDEN', 'approval is missing, expired, used, or does not match this command');
  };
}
