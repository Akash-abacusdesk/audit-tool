import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/** First header value as string | undefined (headers may be string[] per node types). */
export function hdr(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Constant-time check of a `sha256=<hex>` HMAC header against the raw request bytes. */
export function verifySha256Signature(secret: string, raw: Buffer | string, header: string): boolean {
  const mac = createHmac('sha256', secret).update(raw).digest();
  const hex = /^sha256=([0-9a-fA-F]{64})$/.exec(header)?.[1];
  const given = typeof hex === 'string' ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  return given.length === mac.length && timingSafeEqual(given, mac);
}
