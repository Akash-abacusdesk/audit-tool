// S8-D6 webhook HMAC helper (D6 / oscar). Mirrors the canonical S8 WP webhook
// (POST /api/v1/wp/mutation-events, header `x-wp-signature`, dedup delivery_id):
// HMAC-SHA256 over the RAW bytes, compared with crypto.timingSafeEqual. Used by the
// sandbox unit proof to assert forged / tampered / stale deliveries are rejected
// (real crypto, no stack).
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_RE = /^([0-9a-fA-F]{64})$/;

export function sign(secret: string, rawBody: Buffer | string): string {
  const mac = createHmac('sha256', secret).update(rawBody).digest();
  return mac.toString('hex');
}

/** True only when the header is a valid HMAC of rawBody under secret. */
export function verify(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  const hex = SIG_RE.exec(header)?.[1];
  if (!hex) return false;
  const given = Buffer.from(hex, 'hex');
  const mac = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === mac.length && timingSafeEqual(given, mac);
}

/** Replicates the route's stale-delivery check (WEBHOOK_MAX_AGE_MIN, default 10m). */
export function isStale(dateHeader: string | undefined, maxAgeMs: number): boolean {
  if (typeof dateHeader !== 'string') return true;
  const sentAt = new Date(dateHeader).getTime();
  if (!Number.isFinite(sentAt)) return true;
  return Date.now() - sentAt > maxAgeMs;
}
