import type { Pool } from 'pg';
import { ApiError, transitionStaging, type StagingEvent, type StagingState } from '@platform/shared';
import type { StagingStore, StagingStoreEntry } from './queue.js';

interface Row {
  id: string;
  project_id: string;
  environment_id: string;
  ref: string;
  state: StagingState;
  created_at: Date;
}

function toEntry(r: Row): StagingStoreEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    ref: r.ref,
    state: r.state,
    createdAt: r.created_at.toISOString(),
  };
}

/** PostgreSQL-backed staging run store (S11-D1), api_staging_runs (migration 009). */
export class PgStagingStore implements StagingStore {
  constructor(private readonly pool: Pool) {}

  async create(projectId: string, environmentId: string, ref: string): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO api_staging_runs (id, project_id, environment_id, ref, state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'requested')
       RETURNING id`,
      [projectId, environmentId, ref]
    );
    return res.rows[0]!.id;
  }

  async get(id: string): Promise<StagingStoreEntry | null> {
    const res = await this.pool.query<Row>(
      `SELECT id, project_id, environment_id, ref, state, created_at FROM api_staging_runs WHERE id = $1`,
      [id]
    );
    return res.rows[0] ? toEntry(res.rows[0]) : null;
  }

  async apply(id: string, event: StagingEvent): Promise<StagingState> {
    const entry = await this.get(id);
    if (!entry) throw new ApiError('NOT_FOUND', `staging ${id} not found`);
    const next = transitionStaging(entry.state, event);
    await this.pool.query(`UPDATE api_staging_runs SET state = $2, updated_at = now() WHERE id = $1`, [id, next]);
    return next;
  }
}
