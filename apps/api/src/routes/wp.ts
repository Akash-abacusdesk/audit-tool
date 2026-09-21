import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  ApiError,
  ok,
  wpEventEnvelope,
  type WpEventIngestResult,
} from '@platform/shared';
import { recordAudit } from '../auth/audit.js';

interface Deps {
  pool: Pool;
}

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

function hdr(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Reuse the webhook freshness knob — the envelope's occurred_at shares the
// same replay threat model as git webhooks. Dwight's transport also sends an
// x-wp-ts (epoch ms) which is checked first at a tighter ~60s window.
const MAX_AGE_MS = Number(process.env.WEBHOOK_MAX_AGE_MIN ?? 10) * 60_000;
const TS_MAX_AGE_MS = Number(process.env.WP_EVENT_TS_MAX_AGE_MS ?? 60) * 1000;
const BODY_LIMIT = Number(process.env.WEBHOOK_BODY_LIMIT_BYTES ?? 10_485_760);

/**
 * Signed WordPress mutation-event ingest (S8-D1 <- S8-D4, via S8-D2 transport).
 * Canonical contract (god f1c8f8): POST /api/v1/wp/mutation-events
 *   Headers: x-wp-signature: sha256=<hmac-sha256 hex over raw body>  (also
 *            accepts X-WP-Signature for Kevin's plugin), optional
 *            x-wp-ts: <epoch ms> freshness aid, optional x-wp-nonce: <uuid>
 *            (alias for delivery_id dedup). site_id is read from the envelope.
 * Forged (bad sig) -> 401, stale -> 422, duplicate (site_id,delivery_id) -> 200
 * with duplicate:true. Authoritative replay protection is the PK dedup.
 */
export async function wpEventRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  // Capture raw bytes for HMAC; the webhook plugin may already have registered
  // this parser app-wide — tolerate the duplicate-registration error.
  try {
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
      (req as RawBodyRequest).rawBody = body;
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(new ApiError('VALIDATION_ERROR', 'malformed JSON body'), undefined);
      }
    });
  } catch {
    /* parser already present (webhooks) */
  }

  app.post('/wp/mutation-events', { bodyLimit: BODY_LIMIT }, async (req) => {
    const rawReq = req as RawBodyRequest;
    const raw = rawReq.rawBody;
    const sig = hdr(req, 'x-wp-signature') ?? hdr(req, 'X-WP-Signature');
    const tsHeader = hdr(req, 'x-wp-ts');

    // Layer 1 — signature authentication over raw bytes. Generic 401 either way.
    if (typeof sig !== 'string' || !raw) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'wp.event.sig.deny',
        result: 'deny',
        resource: 'wp:?',
        requestId: req.id,
        details: { ip: req.ip },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid signature');
    }

    // Secret resolution: per-site key (if X-WP-Site header sent, Kevin's
    // plugin) else global deployment secret (Dwight's transport shares one).
    // ponytail: single global secret is the day-one model; per-site keys are
    // opt-in via the wp_event_signing_keys table.
    const siteId = hdr(req, 'x-wp-site') ?? hdr(req, 'X-WP-Site');
    const envSecret = process.env.S8_WP_EVENT_SECRET;
    let secret: string | undefined;
    if (typeof siteId === 'string') {
      const key = await deps.pool.query<{ secret: string }>(
        `SELECT secret FROM wp_event_signing_keys WHERE site_id = $1 AND revoked_at IS NULL`,
        [siteId]
      );
      secret = key.rows[0]?.secret;
    }
    if (typeof secret !== 'string') secret = envSecret;
    if (typeof secret !== 'string') {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'wp.event.sig.deny',
        result: 'deny',
        resource: `wp:${siteId ?? '?'}`,
        requestId: req.id,
        details: { ip: req.ip, reason: 'missing-secret' },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid signature');
    }

    const mac = createHmac('sha256', secret).update(raw).digest();
    const hex = /^sha256=([0-9a-fA-F]{64})$/.exec(sig)?.[1];
    const given = typeof hex === 'string' ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
    if (given.length !== mac.length || !timingSafeEqual(given, mac)) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'wp.event.sig.deny',
        result: 'deny',
        resource: `wp:${siteId}`,
        requestId: req.id,
        details: { ip: req.ip },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid signature');
    }

    // Parse + validate envelope (signature is genuine; trust the body shape now).
    const parsed = wpEventEnvelope.safeParse(req.body);
    if (!parsed.success) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'wp.event.deny',
        result: 'deny',
        resource: `wp:${siteId}`,
        requestId: req.id,
        details: { reason: 'invalid-envelope', issues: parsed.error.issues },
      });
      throw new ApiError('VALIDATION_ERROR', 'invalid event envelope');
    }
    const env = parsed.data;

    // Layer 2 — advisory freshness window (the PK dedup is authoritative).
    // Dwight's transport sends x-wp-ts (epoch ms); check it at a tighter ~60s
    // window. Otherwise fall back to the envelope's occurred_at.
    if (typeof tsHeader === 'string') {
      const ts = Number(tsHeader);
      if (!Number.isFinite(ts) || Date.now() - ts > TS_MAX_AGE_MS) {
        await recordAudit(deps.pool, {
          actorId: null,
          action: 'wp.event.stale.deny',
          result: 'deny',
          resource: `wp:${env.site_id}`,
          requestId: req.id,
          details: { delivery_id: env.delivery_id },
        });
        throw new ApiError('VALIDATION_ERROR', 'stale-delivery');
      }
    }
    const occurred = new Date(env.occurred_at).getTime();
    if (!Number.isFinite(occurred) || Date.now() - occurred > MAX_AGE_MS) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'wp.event.stale.deny',
        result: 'deny',
        resource: `wp:${siteId}`,
        requestId: req.id,
        details: { delivery_id: env.delivery_id },
      });
      throw new ApiError('VALIDATION_ERROR', 'stale-delivery');
    }

    // Layer 3 — authoritative dedup. No row inserted => replay => 200 duplicate.
    const inserted = await deps.pool.query<{ id: string }>(
      `INSERT INTO wp_events (site_id, delivery_id, event_type, occurred_at, actor, request_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       ON CONFLICT (site_id, delivery_id) DO NOTHING
       RETURNING id`,
      [
        env.site_id,
        env.delivery_id,
        env.event_type,
        env.occurred_at,
        JSON.stringify(env.actor),
        env.request_id ?? null,
        JSON.stringify(env.details ?? {}),
      ]
    );

    const eventId = inserted.rows[0]?.id ?? null;
    await recordAudit(deps.pool, {
      actorId: null,
      action: 'wp.event.ingest',
      result: eventId ? 'allow' : 'deny',
      resource: `wp:${env.site_id}/${env.delivery_id}`,
      requestId: req.id,
      details: { event_type: env.event_type, delivery_id: env.delivery_id, duplicate: !eventId },
    });

    return ok({ accepted: true, duplicate: !eventId, event_id: eventId } satisfies WpEventIngestResult);
  });
}
