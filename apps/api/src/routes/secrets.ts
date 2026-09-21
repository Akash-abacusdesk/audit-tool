import type { FastifyInstance } from 'fastify';
import { ApiError, assertNotDirectVaultwarden, InMemorySecretsStore, type SecretScope } from '@platform/shared';
import { requirePermission } from '../auth/service.js';

interface Deps {
  pool: import('pg').Pool;
}

/** Shared in-memory secret store (D1 mock). Swap for the Recovery-Host-backed store later. */
export const secretsStore = new InMemorySecretsStore();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseScope(params: { orgId: string; projectId?: string; environmentId?: string }): SecretScope {
  if (!UUID.test(params.orgId)) throw new ApiError('VALIDATION_ERROR', 'orgId must be a uuid');
  const scope: SecretScope = { orgId: params.orgId };
  if (params.projectId !== undefined) {
    if (!UUID.test(params.projectId)) throw new ApiError('VALIDATION_ERROR', 'projectId must be a uuid');
    scope.projectId = params.projectId;
  }
  if (params.environmentId !== undefined) {
    if (!UUID.test(params.environmentId)) throw new ApiError('VALIDATION_ERROR', 'environmentId must be a uuid');
    scope.environmentId = params.environmentId;
  }
  return scope;
}

export async function secretsRoutes(app: FastifyInstance, _deps: Deps): Promise<void> {
  console.log('[boot] plugin:secrets enter');

  // Scoped retrieval — requires secret.read.scoped; workers cannot pull Vaultwarden directly.
  app.get(
    '/secrets/:orgId/:key',
    { preHandler: requirePermission('secret.read.scoped') },
    async (req) => {
      const { orgId, key } = req.params as { orgId: string; key: string };
      const scope = parseScope({
        orgId,
        projectId: (req.query as { projectId?: string })?.projectId,
        environmentId: (req.query as { environmentId?: string })?.environmentId,
      });
      // Hard policy: scanner workers must never read Vaultwarden secrets through this API.
      assertNotDirectVaultwarden(key);
      const value = await secretsStore.get(scope, key);
      if (value === null) throw new ApiError('NOT_FOUND', `secret ${key} not found in scope`);
      return { ok: true as const, data: { key, value } };
    }
  );

  // Scoped upsert — same permission; used by the control plane to stage secrets.
  app.put(
    '/secrets/:orgId/:key',
    { preHandler: requirePermission('secret.read.scoped') },
    async (req) => {
      const { orgId, key } = req.params as { orgId: string; key: string };
      const scope = parseScope({
        orgId,
        projectId: (req.query as { projectId?: string })?.projectId,
        environmentId: (req.query as { environmentId?: string })?.environmentId,
      });
      assertNotDirectVaultwarden(key);
      const b = (req.body ?? {}) as { value?: unknown };
      if (typeof b.value !== 'string') throw new ApiError('VALIDATION_ERROR', 'value (string) is required');
      await secretsStore.put(scope, key, b.value);
      return { ok: true as const, data: { key, stored: true } };
    }
  );

  console.log('[boot] plugin:secrets exit');
}
