import { describe, expect, it, vi } from 'vitest';
import { VaultwardenClientStore } from '@platform/shared';

const scope = { orgId: '11111111-1111-4111-8111-111111111111' };

function client(fetchImpl: typeof fetch) {
  return new VaultwardenClientStore({ baseUrl: 'https://vaultwarden.internal', apiToken: 'tok', fetchImpl });
}

describe('VaultwardenClientStore (private-API client to the external Vaultwarden microservice)', () => {
  it('sends a bearer-authenticated GET and returns the scoped value', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://vaultwarden.internal/secrets/${scope.orgId}/api-key`);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
      return new Response(JSON.stringify({ data: { value: 'shh' } }), { status: 200 });
    });
    const store = client(fetchImpl as unknown as typeof fetch);
    expect(await store.get(scope, 'api-key')).toBe('shh');
  });

  it('returns null on 404 instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const store = client(fetchImpl as unknown as typeof fetch);
    expect(await store.get(scope, 'missing')).toBeNull();
  });

  it('wraps a non-2xx response as an UNAVAILABLE ApiError', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const store = client(fetchImpl as unknown as typeof fetch);
    await expect(store.get(scope, 'api-key')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('wraps a network failure as an UNAVAILABLE ApiError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const store = client(fetchImpl as unknown as typeof fetch);
    await expect(store.get(scope, 'api-key')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('PUTs a JSON body with the value and authorizes with the bearer token', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({ value: 'new-value' });
      return new Response(null, { status: 200 });
    });
    const store = client(fetchImpl as unknown as typeof fetch);
    await store.put(scope, 'api-key', 'new-value');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
