import type { Pool } from 'pg';
import { scopeKey, type SecretScope, type SecretsStore } from '@platform/shared';

/**
 * PostgreSQL-backed scoped secret store (S15-D1). Never holds Vaultwarden
 * material — callers must run `assertNotDirectVaultwarden` before reaching
 * this store (see routes/secrets.ts); this class has no opinion on the key.
 */
export class PgSecretsStore implements SecretsStore {
  constructor(private readonly pool: Pool) {}

  async put(scope: SecretScope, key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_secrets (scope_key, key, org_id, project_id, environment_id, value, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (scope_key, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [scopeKey(scope), key, scope.orgId, scope.projectId ?? null, scope.environmentId ?? null, value]
    );
  }

  async get(scope: SecretScope, key: string): Promise<string | null> {
    const res = await this.pool.query<{ value: string }>(
      `SELECT value FROM api_secrets WHERE scope_key = $1 AND key = $2`,
      [scopeKey(scope), key]
    );
    return res.rows[0]?.value ?? null;
  }

  async delete(scope: SecretScope, key: string): Promise<void> {
    await this.pool.query(`DELETE FROM api_secrets WHERE scope_key = $1 AND key = $2`, [scopeKey(scope), key]);
  }

  async list(scope: SecretScope): Promise<string[]> {
    const res = await this.pool.query<{ key: string }>(`SELECT key FROM api_secrets WHERE scope_key = $1`, [
      scopeKey(scope),
    ]);
    return res.rows.map((r) => r.key);
  }
}
