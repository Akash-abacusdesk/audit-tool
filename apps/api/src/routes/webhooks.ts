import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import {
  ApiError,
  ok,
  JOB,
  GIT_PROVIDERS,
  WEBHOOK_SIGNATURE_HEADERS,
  webhookEventTypes,
  type GitProvider,
  type WebhookEventType,
  type WebhookEventIngest,
} from '@platform/shared';
import { recordAudit } from '../auth/audit.js';
import { withTx } from '../db/pool.js';

interface Deps {
  pool: Pool;
  boss: PgBoss;
}

/** Raw bytes stashed by the plugin-scoped parser before JSON parsing. */
interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

/** First header value as string | undefined (headers may be string[] per node types). */
function hdr(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// ---- Env knobs (capacity-agnostic, see infrastructure/.env.example) ----

const MAX_AGE_MS =
  Number(process.env.WEBHOOK_MAX_AGE_MIN ?? 10) * 60_000;
const BODY_LIMIT = Number(process.env.WEBHOOK_BODY_LIMIT_BYTES ?? 10_485_760);

// ponytail: in-memory limiter is per-process; move to a shared store if the API ever scales out.
const hits = new Map<string, number[]>();
const RATE_MAX = Number(process.env.WEBHOOK_RATE_MAX ?? 30);
const RATE_WINDOW_MS = Number(process.env.WEBHOOK_RATE_WINDOW_MIN ?? 1) * 60_000;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > RATE_MAX;
}

/** Registered provider slugs — day-one ruling: github only (god, S3-D2 GO). */
const REGISTERED: readonly GitProvider[] = (
  process.env.GIT_PROVIDERS ?? 'github'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s): s is GitProvider =>
    (GIT_PROVIDERS as readonly string[]).includes(s)
  );

/** Where each provider carries its delivery GUID (shared defines sig headers only). */
const DELIVERY_ID_HEADERS: Record<GitProvider, string> = {
  github: 'x-github-delivery',
  gitlab: 'x-gitlab-event',
  bitbucket: 'x-request-uuid',
};

/**
 * Map provider event headers to contract event types.
 * Returns null for events we ignore (respond 200 so the provider stops retrying).
 */
function mapGithubEvent(header: string | undefined, payload: any): WebhookEventType | null {
  if (header === 'push') return 'push';
  if (header === 'pull_request') {
    const t = `pull_request.${payload?.action}` as WebhookEventType;
    return (webhookEventTypes as readonly string[]).includes(t) ? t : null;
  }
  return null;
}

export async function webhookRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:webhooks enter');

  if (REGISTERED.length === 0) throw new Error('GIT_PROVIDERS registered no known provider');
  // pg-boss v12 queues are declarative — create before first send (S1 lesson).
  try {
    await deps.boss.createQueue(JOB.webhookReceived);
  } catch {
    // already exists
  }

  // Plugin-scoped raw-body capture: signatures are computed over the ORIGINAL
  // bytes; Fastify's default parser hands routes a re-serialized object. Scoped
  // here so /api/v1 parsing behavior is untouched.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body: Buffer, done) => {
      try {
        ( _req as RawBodyRequest).rawBody = body;
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(new ApiError('VALIDATION_ERROR', 'malformed JSON body'), undefined);
      }
    }
  );

  app.post('/webhooks/git/:provider', { bodyLimit: BODY_LIMIT }, async (req) => {
    const rawReq = req as RawBodyRequest;
    const provider = (req.params as { provider: string }).provider.toLowerCase() as GitProvider;

    // Layer 0 — slug allowlist: unknown providers get the same generic 404 as
    // any other missing route (never confirm the endpoint to probes).
    if (!(REGISTERED as readonly string[]).includes(provider)) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'webhook.provider.deny',
        result: 'deny',
        resource: `git:${provider}`,
        requestId: req.id,
        details: { ip: req.ip },
      });
      throw new ApiError('NOT_FOUND', `route ${req.method} ${req.url} not found`);
    }

    // Abuse limit BEFORE HMAC work (brute-force CPU protection), per IP+provider.
    if (rateLimited(`${req.ip}:${provider}`)) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'webhook.rate.deny',
        result: 'deny',
        resource: `git:${provider}`,
        requestId: req.id,
        details: { ip: req.ip },
      });
      throw new ApiError('RATE_LIMITED', 'too many requests; slow down');
    }

    // Layer 1 — signature authentication over raw bytes. Generic 401 either way:
    // never leak WHICH check failed.
    const secret = process.env[`GIT_WEBHOOK_SECRET_${provider.toUpperCase()}`];
    const receivedSig = hdr(req, WEBHOOK_SIGNATURE_HEADERS[provider]);
    if (typeof secret !== 'string' || secret.length === 0 || typeof receivedSig !== 'string') {
      req.log.error({ provider }, 'webhook secret env missing or signature header absent');
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'webhook.sig.deny',
        result: 'deny',
        resource: `git:${provider}`,
        requestId: req.id,
        details: { ip: req.ip, reason: 'missing-secret-or-header' },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid signature');
    }
    const mac = createHmac('sha256', secret).update(rawReq.rawBody!).digest();
    const hex = /^sha256=([0-9a-fA-F]{64})$/.exec(receivedSig)?.[1];
    const given = typeof hex === 'string' ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
    if (given.length !== mac.length || !timingSafeEqual(given, mac)) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'webhook.sig.deny',
        result: 'deny',
        resource: `git:${provider}`,
        requestId: req.id,
        details: { ip: req.ip },
      });
      throw new ApiError('UNAUTHORIZED', 'invalid signature');
    }

    // Replay-window hardening: deliveries older than WEBHOOK_MAX_AGE_MIN are
    // rejected even when correctly signed (intercepted-then-replayed captures).
    // ponytail ceiling: HTTP Date header is NOT covered by the HMAC, so this is
    // advisory hardening — the PK dedupe below is the authoritative guarantee.
    const dateHdr = hdr(req, 'date');
    const sentAt = typeof dateHdr === 'string' ? new Date(dateHdr).getTime() : NaN;
    if (!Number.isFinite(sentAt) || Date.now() - sentAt > MAX_AGE_MS) {
      await recordAudit(deps.pool, {
        actorId: null,
        action: 'webhook.stale.deny',
        result: 'deny',
        resource: `git:${provider}`,
        requestId: req.id,
        details: { ip: req.ip, dateHeader: typeof dateHdr === 'string' ? dateHdr : null },
      });
      throw new ApiError('VALIDATION_ERROR', 'stale-delivery');
    }

    const deliveryId = hdr(req, DELIVERY_ID_HEADERS[provider]);
    if (typeof deliveryId !== 'string' || deliveryId.length === 0 || deliveryId.length > 200) {
      throw new ApiError('VALIDATION_ERROR', 'missing-delivery-id');
    }

    const payload = req.body;

    // Unknown/uninteresting event types: 200 + ignored so the provider stops
    // retrying something we will never process. Nothing persisted, nothing enqueued.
    const eventType = mapGithubEvent(hdr(req, 'x-github-event'), payload);
    if (!eventType) {
      return ok({ deliveryId, accepted: false, ignored: true });
    }

    // Resolve which connection this delivery belongs to. Unbound repositories
    // respond 200 ignored too: org-level hooks deliver for EVERY repo, and 4xx
    // on unlinked ones would let GitHub disable the hook fleet-wide.
    const repo = (payload as any)?.repository ?? {};
    const externalRepoId = repo.id != null ? String(repo.id) : '';
    const fullName = typeof repo.full_name === 'string' ? repo.full_name : '';
    const conn = await deps.pool.query<{ connection_id: string; org_id: string }>(
      `SELECT rl.connection_id, c.org_id
         FROM api_repo_links rl
         JOIN api_git_connections c ON c.id = rl.connection_id
        WHERE c.provider = $1 AND c.status = 'active'
          AND ($2 <> '' AND (rl.external_repo_id = $2 OR rl.full_name = $3))
        LIMIT 1`,
      [provider, externalRepoId, fullName]
    );
    const link = conn.rows[0];
    if (!link) {
      req.log.warn({ provider, deliveryId, externalRepoId, fullName }, 'webhook for unbound repo ignored');
      return ok({ deliveryId, accepted: false, ignored: true });
    }

    // Layer 2 — replay/duplicate protection: the DB unique index IS the
    // mechanism. No row inserted => replay => success envelope, no re-enqueue.
    const ingest: WebhookEventIngest = {
      connectionId: link.connection_id,
      deliveryId,
      eventType,
      verified: true,
      payload,
    };
    const insertedId = await withTx(deps.pool, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO api_webhook_events (connection_id, delivery_id, event_type, verified, payload)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
         ON CONFLICT (connection_id, delivery_id) DO NOTHING
         RETURNING id`,
        [ingest.connectionId, ingest.deliveryId, ingest.eventType, ingest.verified, JSON.stringify(ingest.payload)]
      );
      return r.rows[0]?.id;
    });

    if (!insertedId) return ok({ duplicate: true });

    // Layer 3 — no-exec boundary: persist an envelope, enqueue AFTER commit;
    // workers re-fetch authoritative state server-side (jim Tier-0 review gate).
    // If enqueue fails, compensate the insert so the provider's retry re-accepts
    // instead of hitting the duplicate path and silently dropping the job.
    try {
      await deps.boss.send(JOB.webhookReceived, { eventId: insertedId });
    } catch (err) {
      await deps.pool.query(
        'DELETE FROM api_webhook_events WHERE id = $1::uuid AND processed_at IS NULL',
        [insertedId]
      );
      throw err;
    }

    return ok({ deliveryId, accepted: true });
  });

  console.log('[boot] plugin:webhooks exit');
}
