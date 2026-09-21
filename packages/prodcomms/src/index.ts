/**
 * S8-D2: secure production -> control-plane communication for WordPress/JIT events.
 *
 * This module owns ONLY the transport-security boundary between a production
 * WordPress host and Jim's S8-D1 ingestion API. It does NOT define the business
 * event schemas (mutation events, JIT requests, redemptions) — those are Jim's
 * ingestion contract. What it provides:
 *
 *   - Signed transport: HMAC-SHA256 over the raw JSON body, echoed in
 *     `x-wp-signature: sha256=<hex>`. The signature IS the credential, mirroring
 *     the house webhook-ingress scheme (docs/security/webhook-ingress-replay.md).
 *     `verifySignature` is exported so the ingestion API reuses the exact verifier.
 *   - Mutual auth (optional): client TLS cert/key + pinned server CA, passed
 *     straight to node:https. No cert = TLS to a public-CA endpoint.
 *   - Egress hardening: https-only (constructor throws on http), pinned host
 *     (a path that escapes the configured host is rejected), no redirect
 *     following, request timeout, response body-size cap.
 *   - Replay aids: every request carries `x-wp-ts` (epoch ms) + `x-wp-nonce`
 *     (uuid); the server dedupes. `isFreshTimestamp` helps the server reject stale.
 *
 * Zero external dependencies — node:crypto / node:https / node:url / node:fs only,
 * consistent with @platform/prodctl and the worker-runtime pattern.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';

export const PRODCOMMS_SIGN_ALGO = 'sha256';
export const PRODCOMMS_SIG_HEADER = 'x-wp-signature';
export const PRODCOMMS_TS_HEADER = 'x-wp-ts';
export const PRODCOMMS_NONCE_HEADER = 'x-wp-nonce';

/** Default ingestion endpoints — Jim's S8-D1 API is expected to serve these. */
export interface ProdCommsEndpoints {
  mutationEvents: string;
  jitRequests: string;
  jitRedeem: string;
}

export const DEFAULT_ENDPOINTS: ProdCommsEndpoints = {
  mutationEvents: '/api/v1/wp/mutation-events',
  jitRequests: '/api/v1/jit/requests',
  jitRedeem: '/api/v1/jit/redeem',
};

export interface ProdCommsTls {
  /** PEM (inline) or a file path. Inline PEM contains '-----BEGIN'. */
  cert?: string;
  key?: string;
  ca?: string;
}

export interface ProdCommsConfig {
  /** Pinned ingestion base URL. MUST be https. Egress is locked to its host. */
  baseUrl: string;
  /** Shared HMAC secret (from secret store — never the repo). */
  secret: string;
  tls?: ProdCommsTls;
  timeoutMs?: number;
  maxResponseBytes?: number;
  endpoints?: Partial<ProdCommsEndpoints>;
  /** Transport seam — inject a fake in tests; defaults to real node:https. */
  transport?: Transport;
}

export class ProdCommsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProdCommsError';
  }
}

// ---------------------------------------------------------------------------
// Signing (shared with the ingestion API)
// ---------------------------------------------------------------------------

export function signBody(raw: string, secret: string): string {
  const mac = createHmac(PRODCOMMS_SIGN_ALGO, secret).update(raw).digest('hex');
  return `${PRODCOMMS_SIGN_ALGO}=${mac}`;
}

/** Constant-time verify. Exported so Jim's S8-D1 route reuses the exact check. */
export function verifySignature(raw: string, secret: string, headerValue: string): boolean {
  const expected = signBody(raw, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(headerValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Server-side staleness check for the `x-wp-ts` replay aid. */
export function isFreshTimestamp(ts: string, maxAgeMs = 60_000): boolean {
  const n = Number(ts);
  if (!Number.isFinite(n)) return false;
  const age = Date.now() - n;
  return age >= 0 && age <= maxAgeMs;
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface TransportOptions {
  method?: string;
  hostname?: string;
  port?: number | string;
  path?: string;
  headers?: Record<string, string | number | undefined>;
  cert?: string;
  key?: string;
  ca?: string;
}

export type Transport = (opts: TransportOptions, body: string) => Promise<TransportResponse>;

function loadPem(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes('-----BEGIN')) return value;
  return readFileSync(value, 'utf8');
}

function buildHttpsOptions(o: TransportOptions): RequestOptions {
  const opts: RequestOptions = {
    method: o.method ?? 'POST',
    hostname: o.hostname,
    port: o.port ? Number(o.port) : 443,
    path: o.path,
    headers: o.headers as Record<string, string | number>,
  };
  if (o.cert) opts.cert = o.cert;
  if (o.key) opts.key = o.key;
  if (o.ca) opts.ca = o.ca;
  return opts;
}

function defaultTransport(timeoutMs: number, maxResponseBytes: number): Transport {
  return (opts, body) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const req = httpsRequest(buildHttpsOptions(opts), (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxResponseBytes) {
            req.destroy();
            reject(new ProdCommsError('RESPONSE_TOO_LARGE', `response exceeded ${maxResponseBytes} bytes`, 502));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      req.on('timeout', () => {
        req.destroy(new ProdCommsError('TIMEOUT', 'request timed out', 504));
      });
      req.on('error', (e) => {
        const code = (e as NodeJS.ErrnoException).code ?? 'TRANSPORT_ERROR';
        reject(new ProdCommsError(code, (e as Error).message, 502));
      });
      req.setTimeout(timeoutMs);
      req.write(body);
      req.end();
    });
}

// ---------------------------------------------------------------------------
// Envelope (control-plane uses the house { ok, data | error } shape)
// ---------------------------------------------------------------------------

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

function tryParseEnvelope(raw: string): Envelope<unknown> | null {
  try {
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === 'object' && 'ok' in (json as object)) return json as Envelope<unknown>;
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ProdCommsClient {
  private readonly baseUrl: string;
  private readonly host: string;
  private readonly secret: string;
  private readonly tls: ProdCommsTls;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly endpoints: ProdCommsEndpoints;
  private readonly transport: Transport;

  constructor(cfg: ProdCommsConfig) {
    if (!cfg.baseUrl) throw new ProdCommsError('CONFIG', 'baseUrl is required');
    if (!cfg.secret) throw new ProdCommsError('CONFIG', 'secret is required');
    let base: URL;
    try {
      base = new URL(cfg.baseUrl);
    } catch {
      throw new ProdCommsError('CONFIG', `baseUrl is not a valid URL: ${cfg.baseUrl}`);
    }
    if (base.protocol !== 'https:') {
      throw new ProdCommsError('EGRESS_INSECURE', `baseUrl must be https, got ${base.protocol}`);
    }
    if (!base.hostname) throw new ProdCommsError('EGRESS_NO_HOST', 'baseUrl is missing a host');

    this.baseUrl = cfg.baseUrl;
    this.host = base.host;
    this.secret = cfg.secret;
    this.tls = cfg.tls ?? {};
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.maxResponseBytes = cfg.maxResponseBytes ?? 1_048_576;
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(cfg.endpoints ?? {}) };
    this.transport = cfg.transport ?? defaultTransport(this.timeoutMs, this.maxResponseBytes);
  }

  /** Send a signed payload to a relative ingestion path. Egress-locked to baseUrl host. */
  async send(path: string, payload: unknown): Promise<unknown> {
    let target: URL;
    try {
      target = new URL(path, this.baseUrl);
    } catch {
      throw new ProdCommsError('BAD_PATH', `invalid request path: ${path}`);
    }
    if (target.protocol !== 'https:') {
      throw new ProdCommsError('EGRESS_INSECURE', 'only https endpoints are permitted');
    }
    if (target.host !== this.host) {
      throw new ProdCommsError('EGRESS_HOST_MISMATCH', `path escapes pinned host ${this.host}`, 400);
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      [PRODCOMMS_SIG_HEADER]: signBody(body, this.secret),
      [PRODCOMMS_TS_HEADER]: Date.now().toString(),
      [PRODCOMMS_NONCE_HEADER]: randomUUID(),
    };

    const options: TransportOptions = {
      method: 'POST',
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      headers,
      cert: loadPem(this.tls.cert),
      key: loadPem(this.tls.key),
      ca: loadPem(this.tls.ca),
    };

    const res = await this.transport(options, body);

    if (res.statusCode >= 300 && res.statusCode < 400) {
      throw new ProdCommsError('EGRESS_REDIRECT', 'control-plane must not redirect; refusing', res.statusCode);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const env = tryParseEnvelope(res.body);
      const err = env && !env.ok ? env.error : undefined;
      const code = err?.code ?? 'UPSTREAM_ERROR';
      const message = err?.message ?? `control-plane returned ${res.statusCode}`;
      throw new ProdCommsError(code, message, res.statusCode, err?.details);
    }

    const env = tryParseEnvelope(res.body);
    if (!env || !env.ok) {
      throw new ProdCommsError('BAD_RESPONSE', 'control-plane returned a non-ok envelope', 502);
    }
    return env.data;
  }

  postMutationEvent(payload: unknown): Promise<unknown> {
    return this.send(this.endpoints.mutationEvents, payload);
  }

  postJitRequest(payload: unknown): Promise<unknown> {
    return this.send(this.endpoints.jitRequests, payload);
  }

  postRedemption(payload: unknown): Promise<unknown> {
    return this.send(this.endpoints.jitRedeem, payload);
  }
}
