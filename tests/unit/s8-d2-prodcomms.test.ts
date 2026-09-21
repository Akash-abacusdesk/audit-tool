import { describe, it, expect } from 'vitest';
import {
  ProdCommsClient,
  ProdCommsError,
  signBody,
  verifySignature,
  isFreshTimestamp,
  PRODCOMMS_SIG_HEADER,
  type Transport,
  type TransportOptions,
  type TransportResponse,
} from '../../packages/prodcomms/src/index.js';

const SECRET = 'test-shared-secret';
const BASE = 'https://ingest.example.com';

/** Simulate Jim's S8-D1 ingestion endpoint: verifies the signature, then answers. */
function fakeIngest(behaviour: {
  status?: number;
  body?: string;
  rejectSig?: boolean;
  capture?: (opts: TransportOptions) => void;
}): Transport {
  return async (opts, body) => {
    behaviour.capture?.(opts);
    const sig = (opts.headers?.[PRODCOMMS_SIG_HEADER] as string) ?? '';
    const valid = !behaviour.rejectSig && verifySignature(body, SECRET, sig);
    if (!valid) {
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad signature' } }),
      };
    }
    return {
      statusCode: behaviour.status ?? 200,
      headers: { 'content-type': 'application/json' },
      body:
        behaviour.body ??
        JSON.stringify({ ok: true, data: { received: true, path: opts.path } }),
    };
  };
}

function client(transport: Transport): ProdCommsClient {
  return new ProdCommsClient({ baseUrl: BASE, secret: SECRET, transport });
}

describe('S8-D2 prodcomms — signing', () => {
  it('signBody round-trips through verifySignature', () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signBody(body, SECRET);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifySignature(body, SECRET, sig)).toBe(true);
  });

  it('verifySignature is false on tampered body or wrong secret', () => {
    const sig = signBody('{"a":1}', SECRET);
    expect(verifySignature('{"a":2}', SECRET, sig)).toBe(false);
    expect(verifySignature('{"a":1}', 'other', sig)).toBe(false);
  });

  it('isFreshTimestamp honors the window', () => {
    expect(isFreshTimestamp(String(Date.now()))).toBe(true);
    expect(isFreshTimestamp(String(Date.now() - 120_000))).toBe(false);
    expect(isFreshTimestamp('not-a-number')).toBe(false);
  });
});

describe('S8-D2 prodcomms — egress hardening', () => {
  it('constructor rejects a non-https baseUrl', () => {
    let err: unknown;
    try {
      new ProdCommsClient({ baseUrl: 'http://ingest.example.com', secret: SECRET });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProdCommsError);
    expect((err as ProdCommsError).code).toBe('EGRESS_INSECURE');
  });

  it('rejects a path that escapes the pinned host', async () => {
    const c = client(fakeIngest({}));
    const err = await c.send('https://evil.example.com/jit/requests', { x: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProdCommsError);
    expect((err as ProdCommsError).code).toBe('EGRESS_HOST_MISMATCH');
  });

  it('refuses to follow redirects (3xx)', async () => {
    const c = client(fakeIngest({ status: 302, body: '' }));
    const err = await c.postMutationEvent({ kind: 'mutation' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProdCommsError);
    expect((err as ProdCommsError).code).toBe('EGRESS_REDIRECT');
  });
});

describe('S8-D2 prodcomms — signed transport', () => {
  it('posts a signed mutation event and returns the envelope data', async () => {
    const c = client(fakeIngest({}));
    const data = await c.postMutationEvent({ kind: 'mutation', plugin: 'akismet' });
    expect(data).toEqual({ received: true, path: '/api/v1/wp/mutation-events' });
  });

  it('posts a JIT request and a redemption to their pinned paths', async () => {
    const seen: string[] = [];
    const c = client(
      fakeIngest({
        capture: (o) => seen.push(o.path ?? ''),
      }),
    );
    await c.postJitRequest({ kind: 'jit.request' });
    await c.postRedemption({ kind: 'jit.redeem', code: 'opaque' });
    expect(seen).toContain('/api/v1/jit/requests');
    expect(seen).toContain('/api/v1/jit/redeem');
  });

  it('maps a 401 bad-signature to ProdCommsError UNAUTHORIZED', async () => {
    const c = client(fakeIngest({ rejectSig: true }));
    const err = await c.postMutationEvent({ kind: 'mutation' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProdCommsError);
    expect((err as ProdCommsError).code).toBe('UNAUTHORIZED');
    expect((err as ProdCommsError).status).toBe(401);
  });

  it('maps an upstream 500 envelope to the upstream error code', async () => {
    const c = client(
      fakeIngest({
        status: 500,
        body: JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }),
      }),
    );
    const err = await c.postMutationEvent({ kind: 'mutation' }).catch((e) => e);
    expect((err as ProdCommsError).code).toBe('INTERNAL');
    expect((err as ProdCommsError).status).toBe(500);
  });

  it('throws BAD_RESPONSE on a non-envelope 200 body', async () => {
    const c = client(fakeIngest({ status: 200, body: 'not json' }));
    const err = await c.postMutationEvent({ kind: 'mutation' }).catch((e) => e);
    expect((err as ProdCommsError).code).toBe('BAD_RESPONSE');
  });

  it('propagates transport timeouts', async () => {
    const slow: Transport = () =>
      Promise.reject(new ProdCommsError('TIMEOUT', 'request timed out', 504));
    const c = client(slow);
    const err = await c.postMutationEvent({ kind: 'mutation' }).catch((e) => e);
    expect((err as ProdCommsError).code).toBe('TIMEOUT');
  });
});

describe('S8-D2 prodcomms — mutual auth plumbing', () => {
  it('passes client cert/key/ca into the transport options', async () => {
    let captured: TransportOptions | undefined;
    const c = new ProdCommsClient({
      baseUrl: BASE,
      secret: SECRET,
      tls: {
        cert: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----',
        key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----',
        ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      },
      transport: (opts) => {
        captured = opts;
        return Promise.resolve({
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ ok: true, data: { received: true } }),
        });
      },
    });
    await c.postMutationEvent({ kind: 'mutation' });
    expect(captured?.cert).toContain('BEGIN CERTIFICATE');
    expect(captured?.key).toContain('BEGIN PRIVATE KEY');
    expect(captured?.ca).toContain('BEGIN CERTIFICATE');
  });
});
