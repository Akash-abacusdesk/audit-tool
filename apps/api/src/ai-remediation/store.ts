import { randomUUID } from 'node:crypto';
import type { Queryable } from '../auth/audit.js';
import type { AiRemediationResult } from '@platform/shared';

export type RemediationRequestStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface RemediationRequestEntry {
  id: string;
  findingId: string;
  projectId: string;
  environmentId: string | null;
  requestedBy: string;
  status: RemediationRequestStatus;
  provider: string | null;
  model: string | null;
  patch: string | null;
  explanation: string | null;
  testGuidance: string | null;
  error: string | null;
  createdAt: string;
}

export interface RemediationStore {
  create(findingId: string, projectId: string, environmentId: string | null, requestedBy: string, db?: Queryable): Promise<string>;
  get(id: string): Promise<RemediationRequestEntry | null>;
  markRunning(id: string): Promise<void>;
  markCompleted(id: string, result: AiRemediationResult): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

/** In-memory remediation-request store — test/dev fallback. Production uses PgRemediationStore. */
export class InMemoryRemediationStore implements RemediationStore {
  private readonly requests = new Map<string, RemediationRequestEntry>();

  async create(findingId: string, projectId: string, environmentId: string | null, requestedBy: string): Promise<string> {
    const id = randomUUID();
    this.requests.set(id, {
      id,
      findingId,
      projectId,
      environmentId,
      requestedBy,
      status: 'queued',
      provider: null,
      model: null,
      patch: null,
      explanation: null,
      testGuidance: null,
      error: null,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async get(id: string): Promise<RemediationRequestEntry | null> {
    return this.requests.get(id) ?? null;
  }

  async markRunning(id: string): Promise<void> {
    const e = this.requests.get(id);
    if (e) e.status = 'running';
  }

  async markCompleted(id: string, result: AiRemediationResult): Promise<void> {
    const e = this.requests.get(id);
    if (!e) return;
    e.status = 'completed';
    e.provider = result.provider;
    e.model = result.model;
    e.patch = result.patch;
    e.explanation = result.explanation;
    e.testGuidance = result.testGuidance;
  }

  async markFailed(id: string, error: string): Promise<void> {
    const e = this.requests.get(id);
    if (!e) return;
    e.status = 'failed';
    e.error = error;
  }
}
