import type { FastifyInstance } from 'fastify';
import {
  ApiError,
  assertNotDirectVaultwarden,
  InMemorySecretsStore,
  isUuid,
  VaultwardenClientStore,
  type SecretsStore,
  type SecretScope,
} from '@platform/shared';
import { assertScope, requirePermission } from '../auth/service.js';
import { PgSecretsStore } from '../secrets/pg-store.js';

interface Deps {
  pool: import('pg').Pool;
}

/**
 * Non-Vaultwarden scoped secrets, durable in `api_secrets` (S15-D1; migration
 * 009). Vaultwarden-prefixed keys are refused before either store is touched
 * (see assertNotDirectVaultwarden) — this store never holds Vaultwarden
 * material. Falls back to an in-memory store only if secretsRoutes is never
 * registered (should not happen outside a test that skips it deliberately).
 */
export let secretsStore: SecretsStore = new InMemorySecretsStore();

/**
 * Control-plane client for the EXTERNAL Vaultwarden microservice (PRD §4.2,
 * §15). `null` when VAULTWARDEN_BASE_URL/VAULTWARDEN_API_TOKEN are unset —
 * every dev/test/CI environment runs without a live Vaultwarden dependency.
 */
export const vaultwardenClient: VaultwardenClientStore | null =
  process.env.VAULTWARDEN_BASE_URL && process.env.VAULTWARDEN_API_TOKEN
    ? new VaultwardenClientStore({
        baseUrl: process.env.VAULTWARDEN_BASE_URL,
        apiToken: process.env.VAULTWARDEN_API_TOKEN,
      })
    : null;

function parseScope(params: { orgId: string; projectId?: string; environmentId?: string }): SecretScope {
  if (!isUuid(params.orgId)) throw new ApiError('VALIDATION_ERROR', 'orgId must be a uuid');
  const scope: SecretScope = { orgId: params.orgId };
  if (params.projectId !== undefined) {
    if (!isUuid(params.projectId)) throw new ApiError('VALIDATION_ERROR', 'projectId must be a uuid');
    scope.projectId = params.projectId;
  }
  if (params.environmentId !== undefined) {
    if (!isUuid(params.environmentId)) throw new ApiError('VALIDATION_ERROR', 'environmentId must be a uuid');
    scope.environmentId = params.environmentId;
  }
  return scope;
}

export async function secretsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:secrets enter');
  secretsStore = new PgSecretsStore(deps.pool);

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
      // requirePermission is a coarse union-over-all-bindings gate; re-check
      // the actor actually holds secret.read.scoped AT THIS orgId/project/env,
      // not just somewhere — otherwise any org grants cross-tenant access.
      await assertScope(req, scope, 'secret.read', 'secret.read.scoped');
      const value = await secretsStore.get(scope, key);
      if (value === null) throw new ApiError('NOT_FOUND', `secret ${key} not found in scope`);
      return { ok: true as const, data: { key, value } };
    }
  );

  // Scoped upsert — needs secret.write.scoped; used by the control plane to stage secrets.
  app.put(
    '/secrets/:orgId/:key',
    { preHandler: requirePermission('secret.write.scoped') },
    async (req) => {
      const { orgId, key } = req.params as { orgId: string; key: string };
      const scope = parseScope({
        orgId,
        projectId: (req.query as { projectId?: string })?.projectId,
        environmentId: (req.query as { environmentId?: string })?.environmentId,
      });
      assertNotDirectVaultwarden(key);
      await assertScope(req, scope, 'secret.put', 'secret.write.scoped');
      const b = (req.body ?? {}) as { value?: unknown };
      if (typeof b.value !== 'string') throw new ApiError('VALIDATION_ERROR', 'value (string) is required');
      await secretsStore.put(scope, key, b.value);
      return { ok: true as const, data: { key, stored: true } };
    }
  );

  // Trusted control-plane retrieval from the EXTERNAL Vaultwarden microservice.
  // Distinct route (not /secrets/:orgId/:key) so the worker-safe path above can
  // never be reached by a Vaultwarden key, by construction, not just by check.
  app.get(
    '/vaultwarden/:orgId/:key',
    { preHandler: requirePermission('secret.read.scoped') },
    async (req) => {
      if (!vaultwardenClient) {
        throw new ApiError('UNAVAILABLE', 'VAULTWARDEN_BASE_URL/VAULTWARDEN_API_TOKEN not configured');
      }
      const { orgId, key } = req.params as { orgId: string; key: string };
      const scope = parseScope({
        orgId,
        projectId: (req.query as { projectId?: string })?.projectId,
        environmentId: (req.query as { environmentId?: string })?.environmentId,
      });
      await assertScope(req, scope, 'secret.read.vaultwarden', 'secret.read.scoped');
      const value = await vaultwardenClient.get(scope, key);
      if (value === null) throw new ApiError('NOT_FOUND', `secret ${key} not found in scope`);
      return { ok: true as const, data: { key, value } };
    }
  );

  console.log('[boot] plugin:secrets exit');
}
