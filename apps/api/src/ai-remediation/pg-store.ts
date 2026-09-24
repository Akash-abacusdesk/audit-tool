import type { Pool } from 'pg';
import type { AiRemediationResult } from '@platform/shared';
import type { RemediationRequestEntry, RemediationRequestStatus, RemediationStore } from './store.js';

interface Row {
  id: string;
  finding_id: string;
  project_id: string;
  environment_id: string | null;
  requested_by: string;
  status: RemediationRequestStatus;
  provider: string | null;
  model: string | null;
  patch: string | null;
  explanation: string | null;
  test_guidance: string | null;
  error: string | null;
  created_at: Date;
}

function toEntry(r: Row): RemediationRequestEntry {
  return {
    id: r.id,
    findingId: r.finding_id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    requestedBy: r.requested_by,
    status: r.status,
    provider: r.provider,
    model: r.model,
    patch: r.patch,
    explanation: r.explanation,
    testGuidance: r.test_guidance,
    error: r.error,
    createdAt: r.created_at.toISOString(),
  };
}

/** PostgreSQL-backed remediation-request store (S20-D1), api_ai_remediation_requests (migration 011). */
export class PgRemediationStore implements RemediationStore {
  constructor(private readonly pool: Pool) {}

  async create(findingId: string, projectId: string, environmentId: string | null, requestedBy: string): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO api_ai_remediation_requests (finding_id, project_id, environment_id, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [findingId, projectId, environmentId, requestedBy]
    );
    return res.rows[0]!.id;
  }

  async get(id: string): Promise<RemediationRequestEntry | null> {
    const res = await this.pool.query<Row>(
      `SELECT id, finding_id, project_id, environment_id, requested_by, status, provider, model, patch, explanation, test_guidance, error, created_at
       FROM api_ai_remediation_requests WHERE id = $1`,
      [id]
    );
    return res.rows[0] ? toEntry(res.rows[0]) : null;
  }

  async markRunning(id: string): Promise<void> {
    await this.pool.query(`UPDATE api_ai_remediation_requests SET status = 'running', updated_at = now() WHERE id = $1`, [id]);
  }

  async markCompleted(id: string, result: AiRemediationResult): Promise<void> {
    await this.pool.query(
      `UPDATE api_ai_remediation_requests
       SET status = 'completed', provider = $2, model = $3, patch = $4, explanation = $5, test_guidance = $6, updated_at = now()
       WHERE id = $1`,
      [id, result.provider, result.model, result.patch, result.explanation, result.testGuidance]
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_ai_remediation_requests SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [id, error]
    );
  }
}
