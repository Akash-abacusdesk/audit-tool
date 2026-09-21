import type { Pool, PoolClient } from 'pg';

/**
 * Centralized audit-event service (Section-2 hard rule): every privileged
 * action and every authorization decision lands here — actor, scope,
 * request ID, result. Callers pass a tx when the audited write is in one,
 * so the event commits or rolls back with it.
 */
export interface AuditEventInput {
  actorId: string | null;
  action: string;
  result: 'allow' | 'deny' | 'error';
  orgId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  resource?: string | null;
  requestId?: string | null;
  details?: unknown;
}

export type Queryable = Pool | PoolClient;

export async function recordAudit(db: Queryable, evt: AuditEventInput): Promise<void> {
  await db.query(
    `INSERT INTO api_audit_events
       (actor_id, action, result, org_id, project_id, environment_id, resource, request_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      evt.actorId,
      evt.action,
      evt.result,
      evt.orgId ?? null,
      evt.projectId ?? null,
      evt.environmentId ?? null,
      evt.resource ?? null,
      evt.requestId ?? null,
      JSON.stringify(evt.details ?? {}),
    ]
  );
}

export interface AuditFilter {
  actorId?: string;
  action?: string;
  result?: 'allow' | 'deny' | 'error';
  orgId?: string;
  projectId?: string;
  environmentId?: string;
  from?: Date;
  to?: Date;
}

/** Compose the WHERE clause + positional params for audit-event listing. */
export function buildAuditWhere(
  f: AuditFilter,
  cursor: { at: Date; id: string } | null
): { where: string; params: unknown[] } {
  const frags: string[] = [];
  const params: unknown[] = [];
  if (cursor) {
    params.push(cursor.at.toISOString(), cursor.id);
    frags.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  if (f.actorId) {
    params.push(f.actorId);
    frags.push(`actor_id = $${params.length}::uuid`);
  }
  if (f.action) {
    params.push(f.action);
    frags.push(`action = $${params.length}`);
  }
  if (f.result) {
    params.push(f.result);
    frags.push(`result = $${params.length}`);
  }
  if (f.orgId) {
    params.push(f.orgId);
    frags.push(`org_id = $${params.length}::uuid`);
  }
  if (f.projectId) {
    params.push(f.projectId);
    frags.push(`project_id = $${params.length}::uuid`);
  }
  if (f.environmentId) {
    params.push(f.environmentId);
    frags.push(`environment_id = $${params.length}::uuid`);
  }
  if (f.from) {
    params.push(f.from.toISOString());
    frags.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (f.to) {
    params.push(f.to.toISOString());
    frags.push(`created_at <= $${params.length}::timestamptz`);
  }
  return { where: frags.join(' AND ') || 'TRUE', params };
}
