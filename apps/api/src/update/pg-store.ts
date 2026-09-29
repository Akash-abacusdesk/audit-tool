import type { Pool } from 'pg';
import type { Queryable } from '../auth/audit.js';
import { ApiError, transitionUpdate, type TransitionContext, type UpdateEvent, type UpdateState } from '@platform/shared';
import type { UpdateStore, UpdateUnitEntry } from './queue.js';

interface Row {
  id: string;
  project_id: string;
  environment_id: string;
  component: string;
  from_version: string;
  to_version: string;
  state: UpdateState;
  created_at: Date;
}

function toEntry(r: Row): UpdateUnitEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    component: r.component,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    state: r.state,
    createdAt: r.created_at.toISOString(),
  };
}

/** PostgreSQL-backed update-unit store (S13-D1), api_update_units (migration 010). */
export class PgUpdateStore implements UpdateStore {
  constructor(private readonly pool: Pool) {}

  async create(
    projectId: string,
    environmentId: string,
    component: string,
    fromVersion: string,
    toVersion: string,
    db: Queryable = this.pool
  ): Promise<string> {
    const res = await (db as Pool).query<{ id: string }>(
      `INSERT INTO api_update_units (project_id, environment_id, component, from_version, to_version)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [projectId, environmentId, component, fromVersion, toVersion]
    );
    return res.rows[0]!.id;
  }

  async get(id: string, db: Queryable = this.pool, lock = false): Promise<UpdateUnitEntry | null> {
    const res = await (db as Pool).query<Row>(
      `SELECT id, project_id, environment_id, component, from_version, to_version, state, created_at
       FROM api_update_units WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id]
    );
    return res.rows[0] ? toEntry(res.rows[0]) : null;
  }

  async apply(id: string, event: UpdateEvent, ctx?: TransitionContext, db: Queryable = this.pool): Promise<UpdateState> {
    // FOR UPDATE: concurrent transitions on one unit serialize instead of both reading the same state.
    const entry = await this.get(id, db, true);
    if (!entry) throw new ApiError('NOT_FOUND', `update unit ${id} not found`);
    const next = transitionUpdate(entry.state, event, ctx);
    await db.query(`UPDATE api_update_units SET state = $2, updated_at = now() WHERE id = $1`, [id, next]);
    return next;
  }
}
