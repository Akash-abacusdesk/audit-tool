/**
 * Section-15 Security/Recovery Host — D1 scoped secret retrieval.
 *
 * Secrets are stored per scope (org / project / environment) and retrieved
 * exclusively through the control plane. The defining policy: scanner workers
 * MUST NOT connect to Vaultwarden directly. Any attempt to read a Vaultwarden-
 * scoped secret through this path is refused — workers receive secrets only as
 * scoped, injected values via the control plane (never their own Vaultwarden creds).
 */
import { ApiError } from './errors.js';

export interface SecretScope {
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
}

/** Vaultwarden secrets are isolated from scanner workers by policy. */
export const VAULTWARDEN_KEY_PREFIX = 'vaultwarden:';

export interface SecretsStore {
  put(scope: SecretScope, key: string, value: string): Promise<void>;
  get(scope: SecretScope, key: string): Promise<string | null>;
  delete(scope: SecretScope, key: string): Promise<void>;
  list(scope: SecretScope): Promise<string[]>;
}

/** Stable, order-independent key for a scope. */
export function scopeKey(s: SecretScope): string {
  return [s.orgId, s.projectId ?? '', s.environmentId ?? ''].join(' ');
}

/**
 * Throw FORBIDDEN if `key` names a Vaultwarden secret. Scanner workers calling
 * this (or retrieveScopedSecret with allowVaultwarden=false) are refused — they
 * must get secrets via the control-plane scoped path instead.
 */
export function assertNotDirectVaultwarden(key: string): void {
  if (key.startsWith(VAULTWARDEN_KEY_PREFIX)) {
    throw new ApiError(
      'FORBIDDEN',
      'scanner workers cannot access Vaultwarden directly; retrieve via control-plane scoped retrieval'
    );
  }
}

/** In-memory mock store — the contract implementation CI/units exercise. */
export class InMemorySecretsStore implements SecretsStore {
  private readonly map = new Map<string, string>();

  private k(scope: SecretScope, key: string): string {
    return `${scopeKey(scope)} ${key}`;
  }

  async put(scope: SecretScope, key: string, value: string): Promise<void> {
    this.map.set(this.k(scope, key), value);
  }

  async get(scope: SecretScope, key: string): Promise<string | null> {
    return this.map.get(this.k(scope, key)) ?? null;
  }

  async delete(scope: SecretScope, key: string): Promise<void> {
    this.map.delete(this.k(scope, key));
  }

  async list(scope: SecretScope): Promise<string[]> {
    const prefix = `${scopeKey(scope)} `;
    const out: string[] = [];
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  }
}

/**
 * Control-plane scoped retrieval. By default refuses Vaultwarden keys (worker
 * context). Pass allowVaultwarden:true only from the trusted control plane that
 * legitimately fans secrets out to workers.
 */
export async function retrieveScopedSecret(
  store: SecretsStore,
  scope: SecretScope,
  key: string,
  opts?: { allowVaultwarden?: boolean }
): Promise<string | null> {
  if (!opts?.allowVaultwarden) assertNotDirectVaultwarden(key);
  return store.get(scope, key);
}
