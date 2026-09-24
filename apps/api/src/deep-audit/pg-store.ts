import type { Pool } from 'pg';
import { buildDeepAuditReport, type DeepAuditRunState, type DeepAuditTarget } from '@platform/shared';
import type { DeepAuditStore, DeepAuditStoreEntry } from './queue.js';

interface Row {
  id: string;
  target: DeepAuditTarget;
  state: DeepAuditRunState | null;
  report: DeepAuditStoreEntry['report'];
  created_at: Date;
}

function toEntry(r: Row): DeepAuditStoreEntry {
  return { id: r.id, target: r.target, state: r.state, report: r.report, createdAt: r.created_at.toISOString() };
}

/** PostgreSQL-backed deep-audit run store (S14-D3), api_deep_audit_runs (migration 009). */
export class PgDeepAuditStore implements DeepAuditStore {
  constructor(private readonly pool: Pool) {}

  async create(target: DeepAuditTarget): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO api_deep_audit_runs (id, target) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [JSON.stringify(target)]
    );
    return res.rows[0]!.id;
  }

  async get(id: string): Promise<DeepAuditStoreEntry | null> {
    const res = await this.pool.query<Row>(
      `SELECT id, target, state, report, created_at FROM api_deep_audit_runs WHERE id = $1`,
      [id]
    );
    return res.rows[0] ? toEntry(res.rows[0]) : null;
  }

  async setResult(id: string, state: DeepAuditRunState): Promise<void> {
    const report = buildDeepAuditReport(state);
    await this.pool.query(
      `UPDATE api_deep_audit_runs SET state = $2, report = $3, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(state), JSON.stringify(report)]
    );
  }
}
