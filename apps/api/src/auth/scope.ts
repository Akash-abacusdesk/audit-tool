import type { FastifyRequest } from 'fastify';
import { ApiError, permissionsFor, type Permission } from '@platform/shared';
import { assertScope } from './service.js';

/**
 * Resolve the owning org of a project (and confirm the environment belongs to
 * that project), then require `perm` at exactly that scope. Routes that take
 * projectId/environmentId from a body or a stored row use this instead of the
 * coarse requirePermission() gate alone, which passes for a binding in ANY org.
 */
export async function assertProjectScope(
  req: FastifyRequest,
  projectId: string,
  environmentId: string | null | undefined,
  action: string,
  perm: Permission
): Promise<void> {
  const { rows } = await req.server.pool.query<{ org_id: string; env_ok: boolean | null }>(
    `SELECT p.org_id::text AS org_id,
            CASE WHEN $2::uuid IS NULL THEN NULL
                 ELSE EXISTS (SELECT 1 FROM api_environments e WHERE e.id = $2::uuid AND e.project_id = p.id) END AS env_ok
       FROM api_projects p WHERE p.id = $1`,
    [projectId, environmentId ?? null]
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
  if (environmentId && !row.env_ok) throw new ApiError('NOT_FOUND', `environment ${environmentId} not found in project`);
  await assertScope(req, { orgId: row.org_id, projectId, environmentId: environmentId ?? null }, action, perm);
}

/** Orgs where the actor holds `perm` at org level (a project/env-scoped binding does not count). */
export function orgsWith(req: FastifyRequest, perm: Permission): string[] {
  const bindings = req.actor!.bindings;
  return [...new Set(bindings.map((b) => b.orgId))].filter((orgId) => permissionsFor(bindings, { orgId }).has(perm));
}
