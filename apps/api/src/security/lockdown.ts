/**
 * S16 runbook action 5: emergency lockdown. A single platform-wide switch
 * that blocks production-mutating and new-privileged-grant actions during a
 * management-host compromise, while deliberately leaving JIT revocation and
 * every read/audit endpoint unblocked — you need those DURING the incident
 * (see docs/security/compromise-response-runbook.md, action 4 vs action 5).
 *
 * Read fresh on every gated request, no cache: matches the existing
 * fresh-RBAC pattern (Telegram/JIT authorization re-read the DB every call)
 * rather than risking a stale in-memory flag during an incident.
 */
import type { Pool } from 'pg';
import type { Permission } from '@platform/shared';

/** Blocked while locked down. Everything else (reads, audit, JIT revoke) stays open. */
export const LOCKDOWN_BLOCKED_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'prod.execute',
  'update.manage',
  'jit.approve',
  'finding.remediate',
]);

export async function isLockedDown(pool: Pool): Promise<boolean> {
  const res = await pool.query<{ enabled: boolean }>(
    'SELECT enabled FROM emergency_lockdown WHERE id = true'
  );
  return res.rows[0]?.enabled ?? false;
}

export interface LockdownStatus {
  enabled: boolean;
  reason: string | null;
  enabledBy: string | null;
  enabledAt: string | null;
  disabledBy: string | null;
  disabledAt: string | null;
}

export async function getLockdownStatus(pool: Pool): Promise<LockdownStatus> {
  const res = await pool.query<{
    enabled: boolean;
    reason: string | null;
    enabled_by: string | null;
    enabled_at: Date | null;
    disabled_by: string | null;
    disabled_at: Date | null;
  }>('SELECT enabled, reason, enabled_by::text, enabled_at, disabled_by::text, disabled_at FROM emergency_lockdown WHERE id = true');
  const r = res.rows[0]!;
  return {
    enabled: r.enabled,
    reason: r.reason,
    enabledBy: r.enabled_by,
    enabledAt: r.enabled_at?.toISOString() ?? null,
    disabledBy: r.disabled_by,
    disabledAt: r.disabled_at?.toISOString() ?? null,
  };
}

export async function setLockdown(
  pool: Pool,
  enabled: boolean,
  actorId: string,
  reason?: string
): Promise<LockdownStatus> {
  if (enabled) {
    await pool.query(
      `UPDATE emergency_lockdown SET enabled = true, reason = $1, enabled_by = $2, enabled_at = now()
       WHERE id = true`,
      [reason ?? null, actorId]
    );
  } else {
    await pool.query(
      `UPDATE emergency_lockdown SET enabled = false, disabled_by = $1, disabled_at = now()
       WHERE id = true`,
      [actorId]
    );
  }
  return getLockdownStatus(pool);
}
