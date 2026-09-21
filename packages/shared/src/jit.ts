/**
 * Section-8 contract surface (S8-D1): WordPress signed mutation-event ingest
 * envelope + just-in-time privileged-access grant lifecycle DTOs.
 *
 * This module is the convergence point for the whole S8 plane:
 *   - Kevin (S8-D4) WP MU-plugin signs events and redeems JIT tokens against
 *     the routes that consume these types.
 *   - Angela (S8-D5) builds the approval/grant UI against these DTOs.
 *   - Oscar (S8-D6) tests behavior against this contract.
 *
 * Signing scheme mirrors the existing webhook verifier (HMAC-SHA256 over the
 * raw request body, `sha256=<hex>`, verified with timingSafeEqual) so the WP
 * plugin reuses the same mental model as the git webhook ingress.
 */

import { z } from 'zod';

// ---- WordPress signed event envelope (S8-D4 -> S8-D1 ingest) ----

export const WP_EVENT_SCHEMA_VERSION = 'wp-mutation-events/1.0';

/** The 11 mutation event types the WP MU-plugin may emit. */
export const WP_EVENT_TYPES = [
  'admin_user_create',
  'admin_user_delete',
  'role_change',
  'plugin_install',
  'plugin_activate',
  'plugin_deactivate',
  'plugin_update',
  'plugin_delete',
  'core_update',
  'jit.session_create',
  'jit.session_revoke',
] as const;

export type WpEventType = (typeof WP_EVENT_TYPES)[number];

export const wpEventActor = z
  .object({
    type: z.string().min(1).max(40),
    id: z.string().min(1).max(200),
    ip: z.string().max(64).optional(),
    grant_id: z.string().max(200).optional(),
  })
  .passthrough();

export const wpEventEnvelope = z.object({
  schema_version: z.literal(WP_EVENT_SCHEMA_VERSION),
  site_id: z.string().min(1).max(200),
  delivery_id: z.string().min(1).max(200),
  event_type: z.enum(WP_EVENT_TYPES),
  occurred_at: z.string().datetime({ offset: true }),
  actor: wpEventActor,
  request_id: z.string().max(200).optional(),
  details: z.record(z.unknown()).optional(),
});

export type WpEventEnvelope = z.infer<typeof wpEventEnvelope>;

export interface WpEventIngestResult {
  accepted: boolean;
  duplicate: boolean;
  event_id: string | null;
}

// ---- JIT grant lifecycle (S8-D1 core) ----

export const JIT_GRANT_MAX_MINUTES = 60 * 24 * 7;

export const jitRequestInput = z.object({
  site_id: z.string().min(1).max(200),
  reason: z.string().min(1).max(500),
  duration_minutes: z.number().int().min(1).max(JIT_GRANT_MAX_MINUTES),
  scope: z
    .object({
      orgId: z.string().uuid(),
      projectId: z.string().uuid().optional(),
      environmentId: z.string().uuid().optional(),
    })
    .optional(),
});

export type JitRequestInput = z.infer<typeof jitRequestInput>;

/** Redemption presents the SHA-256 hex of the opaque one-time token. */
export const jitRedeemInput = z.object({
  request_id: z.string().min(1).max(200),
  token_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export type JitRedeemInput = z.infer<typeof jitRedeemInput>;

export const jitRevokeInput = z.object({
  grant_id: z.string().min(1).max(200),
});

export type JitRevokeInput = z.infer<typeof jitRevokeInput>;

export type JitRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type JitGrantStatus = 'active' | 'consumed' | 'expired' | 'revoked';

export interface JitRequestDto {
  id: string;
  site_id: string;
  reason: string;
  duration_minutes: number;
  status: JitRequestStatus;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  approved_at: string | null;
}

export interface JitGrantDto {
  grant_id: string;
  ttl_seconds: number;
  requester: string | null;
  site_id: string;
  status: JitGrantStatus;
  issued_at: string;
  expires_at: string;
}
