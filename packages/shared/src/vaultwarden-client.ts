/**
 * Section-15 Security/Recovery Host — private-API client to the EXTERNAL
 * Vaultwarden microservice.
 *
 * Vaultwarden is no longer hosted by this platform (see PRD §3, §4.2): it is
 * a separate microservice with its own datastore, reached only through a
 * private, authenticated API call. This client is the ONLY thing in this
 * platform allowed to call it — scanner workers and the portal never do
 * (enforced by `assertNotDirectVaultwarden` in secrets.ts).
 *
 * The external service is expected to expose the same scoped-secret shape
 * this platform already uses internally (org/project/environment scope +
 * key), over HTTPS with a bearer service token. Swap the base URL/token via
 * env; no other code needs to change when the external service's deployment
 * moves.
 */
import { ApiError } from './errors.js';
import type { SecretScope, SecretsStore } from './secrets.js';
import { withRetry } from './retry.js';

export interface VaultwardenClientConfig {
  /** Base URL of the external Vaultwarden microservice's private API, e.g. https://vaultwarden.internal. */
  baseUrl: string;
  /** Bearer service token minted for this control plane; never a user credential. */
  apiToken: string;
  /** Request timeout in ms. Defaults to 5000 — this is a synchronous dependency of user-facing requests. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function scopeQuery(scope: SecretScope): string {
  const params = new URLSearchParams();
  if (scope.projectId) params.set('projectId', scope.projectId);
  if (scope.environmentId) params.set('environmentId', scope.environmentId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * HTTP client for the external Vaultwarden microservice's private API.
 * Implements the same `SecretsStore` contract as `InMemorySecretsStore` so it
 * is a drop-in swap at the route layer (see apps/api/src/routes/secrets.ts).
 */
export class VaultwardenClientStore implements SecretsStore {
  constructor(private readonly config: VaultwardenClientConfig) {}

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const f = withRetry(this.config.fetchImpl ?? fetch);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);
    try {
      return await f(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApiError(
        'UNAVAILABLE',
        `vaultwarden private API unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async put(scope: SecretScope, key: string, value: string): Promise<void> {
    const res = await this.request('PUT', `/secrets/${scope.orgId}/${encodeURIComponent(key)}${scopeQuery(scope)}`, {
      value,
    });
    if (!res.ok) {
      throw new ApiError('UNAVAILABLE', `vaultwarden put failed: ${res.status}`);
    }
  }

  async get(scope: SecretScope, key: string): Promise<string | null> {
    const res = await this.request('GET', `/secrets/${scope.orgId}/${encodeURIComponent(key)}${scopeQuery(scope)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ApiError('UNAVAILABLE', `vaultwarden get failed: ${res.status}`);
    }
    const body = (await res.json()) as { data?: { value?: string } };
    return body.data?.value ?? null;
  }

  async delete(scope: SecretScope, key: string): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/secrets/${scope.orgId}/${encodeURIComponent(key)}${scopeQuery(scope)}`
    );
    if (!res.ok && res.status !== 404) {
      throw new ApiError('UNAVAILABLE', `vaultwarden delete failed: ${res.status}`);
    }
  }

  async list(scope: SecretScope): Promise<string[]> {
    const res = await this.request('GET', `/secrets/${scope.orgId}${scopeQuery(scope)}`);
    if (!res.ok) {
      throw new ApiError('UNAVAILABLE', `vaultwarden list failed: ${res.status}`);
    }
    const body = (await res.json()) as { data?: { keys?: string[] } };
    return body.data?.keys ?? [];
  }
}
