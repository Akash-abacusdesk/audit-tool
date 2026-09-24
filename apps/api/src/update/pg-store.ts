import type { Pool } from 'pg';
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
    toVersion: string
  ): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO api_update_units (project_id, environment_id, component, from_version, to_version)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [projectId, environmentId, component, fromVersion, toVersion]
    );
    return res.rows[0]!.id;
  }

  async get(id: string): Promise<UpdateUnitEntry | null> {
    const res = await this.pool.query<Row>(
      `SELECT id, project_id, environment_id, component, from_version, to_version, state, created_at
       FROM api_update_units WHERE id = $1`,
      [id]
    );
    return res.rows[0] ? toEntry(res.rows[0]) : null;
  }

  async apply(id: string, event: UpdateEvent, ctx?: TransitionContext): Promise<UpdateState> {
    const entry = await this.get(id);
    if (!entry) throw new ApiError('NOT_FOUND', `update unit ${id} not found`);
    const next = transitionUpdate(entry.state, event, ctx);
    await this.pool.query(`UPDATE api_update_units SET state = $2, updated_at = now() WHERE id = $1`, [id, next]);
    return next;
  }
}
