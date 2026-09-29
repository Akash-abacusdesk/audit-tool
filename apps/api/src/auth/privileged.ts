import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '@platform/shared';
import { recordAudit } from './audit.js';

/**
 * S2-D2 privileged-admin enforcement (docs/security/privileged-admin-auth.md).
 * Three gates layered on top of the ordinary RBAC resolver:
 *   1. management-network origin (deny-by-default CIDR list),
 *   2. fresh step-up proof on the session,
 *   3. audit-export spool health — when the off-host export spool is full,
 *      NEW privileged logins are blocked while normal traffic keeps running.
 */

/** Admin-plane permissions; anything else stays ordinary-session territory. */
export const PRIVILEGED_PERMISSIONS: ReadonlySet<string> = new Set([
  'org.manage',
  'project.manage',
  'user.manage',
  'role.assign',
  'audit.read',
]);

const STEP_UP_TTL_MS =
  Number(process.env.ADMIN_STEPUP_TTL_MIN ?? 15) * 60_000;

// ponytail: default = loopback only so dev compose parity holds with zero config;
// production sets ADMIN_NETS to the WireGuard mgmt net (10.10.0.0/24) + loopback.
function adminNets(): string[] {
  return (process.env.ADMIN_NETS ?? '127.0.0.0/8,::1,::ffff:127.0.0.0/104')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function v4ToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** True when `ip` falls inside cidr (IPv4 / v4-mapped IPv6 only). */
export function ipInCidr(ip: string, cidr: string): boolean {
  // Strip IPv4-mapped prefix so ::ffff:10.0.0.1 compares as v4.
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  const [netRaw, bitsStr] = cidr.split('/');
  const net = netRaw ?? '';
  const bits = Number(bitsStr ?? (isIP(net) === 6 ? 128 : 32));
  if (isIP(ip) === 6 && isIP(net) === 6) return ip.toLowerCase() === net.toLowerCase(); // exact-host v6 entries
  if (!ip || !net) return false;
  const a = v4ToLong(ip);
  const b = v4ToLong(net);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * Gate 1: request must originate from the management network.
 * Deny-by-default: an unparseable IP matches nothing.
 */
export async function assertManagementNetwork(req: FastifyRequest): Promise<void> {
  const ip = req.ip ?? '';
  const okNet = adminNets().some((cidr) => ipInCidr(ip, cidr));
  if (!okNet) {
    await recordAudit(req.server.pool, {
      actorId: req.actor?.user.id ?? null,
      action: 'admin.network.deny',
      result: 'deny',
      resource: `${req.method} ${req.url}`,
      requestId: req.id,
      details: { ip },
    });
    throw new ApiError('FORBIDDEN', 'administration is restricted to the management network');
  }
}

/**
 * Gate 2: the actor's session must carry a fresh step-up proof
 * (POST /auth/step-up re-verifies the password and stamps api_sessions.step_up_at).
 */
export function stepUpFresh(req: FastifyRequest): boolean {
  const at = req.stepUpAt;
  return at !== null && at !== undefined && Date.now() - at.getTime() <= STEP_UP_TTL_MS;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by resolveActorWithStepUp; null = no proof on this session. */
    stepUpAt?: Date | null;
  }
}

/** Gate 2 thrower — audited, distinct details flag so UIs can trigger re-auth. */
export async function assertFreshStepUp(req: FastifyRequest): Promise<void> {
  if (stepUpFresh(req)) return;
  await recordAudit(req.server.pool, {
    actorId: req.actor!.user.id,
    action: 'authz.deny.stepup.stale',
    result: 'deny',
    resource: `${req.method} ${req.url}`,
    requestId: req.id,
  });
  throw new ApiError('FORBIDDEN', 'step-up authentication required for privileged operations', {
    stepUpRequired: true,
    maxAgeMinutes: Math.round(STEP_UP_TTL_MS / 60_000),
  });
}

/**
 * Gate 3: audit exporter marks a full local spool with a sentinel file;
 * privileged step-ups stop until ops drains it (spool-full policy:
 * block new PRIVILEGED ops only — normal traffic unaffected).
 */
export function spoolFullPath(): string | null {
  return process.env.AUDIT_SPOOL_DIR ?? null;
}

export async function assertSpoolHasRoom(req: FastifyRequest): Promise<void> {
  const dir = spoolFullPath();
  if (!dir) return; // not deployed alongside a spool → policy enforced by exporter host
  try {
    const { existsSync } = await import('node:fs');
    if (!existsSync(`${dir}/.SPOOL_FULL`)) return;
  } catch {
    return; // unreadable spool must not take down the API
  }
  await recordAudit(req.server.pool, {
    actorId: req.actor?.user.id ?? null,
    action: 'authz.deny.spool_full',
    result: 'deny',
    resource: `${req.method} ${req.url}`,
    requestId: req.id,
  });
  throw new ApiError(
    'UNAVAILABLE',
    'audit export spool is full; privileged operations are blocked until it drains',
    { reason: 'audit-spool-full' }
  );
}

/** URL prefixes that make up the admin plane (management-network + step-up scope). */
export const ADMIN_URL_PREFIXES = [
  '/users',
  '/role-bindings',
  '/orgs',
  '/projects',
  '/environments',
  '/audit-events',
  '/security/lockdown',
  // S4VAL-1 (ruling B): scheduler plane carries privileged pair-tier ops
  // (enqueue/cancel arbitrary workloads) — same posture as the audit feed.
  // Internal probe endpoints live under /internal/… and stay outside this gate.
  '/scheduler',
  // Production-affecting human actions: command execution and update promotion.
  '/prod',
  '/update-units',
] as const;

export function isAdminUrl(rawUrl: string): boolean {
  // Normalize: drop query + mount prefix so the check works from any registration root.
  const path = rawUrl.split('?')[0]!.replace(/^\/api\/v1/, '');
  return ADMIN_URL_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
