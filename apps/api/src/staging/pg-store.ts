import type { Pool } from 'pg';
import type { Queryable } from '../auth/audit.js';
import { ApiError, transitionStaging, type StagingEvent, type StagingState } from '@platform/shared';
import type { StagingRuntimeRecord, StagingStore, StagingStoreEntry } from './queue.js';

interface Row {
  id: string;
  project_id: string;
  environment_id: string;
  ref: string;
  state: StagingState;
  created_at: Date;
  runtime: StagingRuntimeRecord | null;
}

function toEntry(r: Row): StagingStoreEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    ref: r.ref,
    state: r.state,
    createdAt: r.created_at.toISOString(),
    runtime: r.runtime,
  };
}

/** PostgreSQL-backed staging run store (S11-D1), api_staging_runs (migration 009). */
export class PgStagingStore implements StagingStore {
  constructor(private readonly pool: Pool) {}

  async create(projectId: string, environmentId: string, ref: string, db: Queryable = this.pool): Promise<string> {
    const res = await (db as Pool).query<{ id: string }>(
      `INSERT INTO api_staging_runs (id, project_id, environment_id, ref, state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'requested')
       RETURNING id`,
      [projectId, environmentId, ref]
    );
    return res.rows[0]!.id;
  }

  async get(id: string, db: Queryable = this.pool, lock = false): Promise<StagingStoreEntry | null> {
    const res = await (db as Pool).query<Row>(
      `SELECT id, project_id, environment_id, ref, state, created_at, runtime FROM api_staging_runs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id]
    );
    return res.rows[0] ? toEntry(res.rows[0]) : null;
  }

  async apply(id: string, event: StagingEvent, db: Queryable = this.pool): Promise<StagingState> {
    // FOR UPDATE: two concurrent transitions on one run serialize instead of both reading the same state.
    const entry = await this.get(id, db, true);
    if (!entry) throw new ApiError('NOT_FOUND', `staging ${id} not found`);
    const next = transitionStaging(entry.state, event);
    await db.query(`UPDATE api_staging_runs SET state = $2, updated_at = now() WHERE id = $1`, [id, next]);
    return next;
  }

  async setRuntime(id: string, runtime: StagingRuntimeRecord): Promise<void> {
    const res = await this.pool.query(
      `UPDATE api_staging_runs SET runtime = $2, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(runtime)]
    );
    if (res.rowCount === 0) throw new ApiError('NOT_FOUND', `staging ${id} not found`);
  }
}
