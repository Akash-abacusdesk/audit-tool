import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  can,
  isUuid,
  ApiError,
  ok,
  findingInput,
  type FindingInput,
  findingListQuery,
  findingUpdateInput,
  scanEnvelope,
  type Confidence,
  type FindingDto,
  type FindingStatus,
  type IngestResultDto,
  type Page,
  type RemediationStatus,
  type ScanEnvelope,
  type ScanRunDto,
  type Severity,
} from '@platform/shared';
import { recordAudit } from '../auth/audit.js';
import { assertScope, requirePermission } from '../auth/service.js';
import { withTx } from '../db/pool.js';
import { enqueueCriticalFindingAlerts } from '../notifications/outbox.js';
import type { Scheduler } from '../scheduler/scheduler.js';

interface Deps {
  pool: Pool;
  scheduler?: Scheduler;
}

const ENDPOINT = 'POST /api/v1/scans/:scanId/findings';

type FindingRow = {
  id: string;
  scan_run_id: string;
  project_id: string;
  environment_id: string | null;
  finding_fingerprint: string;
  rule_id: string | null;
  title: string;
  description: string | null;
  severity: Severity;
  native_severity: string | null;
  confidence: Confidence;
  scanner: string;
  scanner_version: string | null;
  image_digest: string | null;
  target_ref: string | null;
  target_branch: string | null;
  location: unknown;
  evidence: string | null;
  remediation: unknown;
  cve_ids: string[] | null;
  advisory_ids: string[] | null;
  metadata: unknown;
  raw_artifact_path: string | null;
  status: FindingStatus;
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: Date | null;
  remediation_status: RemediationStatus;
  resolved_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
};

function toFindingDto(r: FindingRow): FindingDto {
  return {
    id: r.id,
    scanRunId: r.scan_run_id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    fingerprint: r.finding_fingerprint,
    ruleId: r.rule_id,
    title: r.title,
    description: r.description,
    severity: r.severity,
    nativeSeverity: r.native_severity,
    confidence: r.confidence,
    scanner: r.scanner,
    scannerVersion: r.scanner_version,
    imageDigest: r.image_digest,
    targetRef: r.target_ref,
    targetBranch: r.target_branch,
    location: r.location,
    evidence: r.evidence,
    remediation: r.remediation,
    cveIds: r.cve_ids,
    advisoryIds: r.advisory_ids,
    metadata: r.metadata,
    rawArtifactPath: r.raw_artifact_path,
    status: r.status,
    assignedTo: r.assigned_to,
    assignedBy: r.assigned_by,
    assignedAt: r.assigned_at ? r.assigned_at.toISOString() : null,
    remediationStatus: r.remediation_status,
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    firstSeenAt: r.first_seen_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Resolve a project to its org for scope checks; 404 when unknown. */
async function resolveProjectScope(
  pool: Pool,
  projectId: string
): Promise<{ orgId: string; projectId: string }> {
  const r = await pool.query<{ org_id: string }>(
    'SELECT org_id::text FROM api_projects WHERE id = $1',
    [projectId]
  );
  const orgId = r.rows[0]?.org_id;
  if (!orgId) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
  return { orgId, projectId };
}

function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * `at` is PG's own microsecond-precision text form of created_at, not a JS Date: rows written by one ingest share a
 * timestamp, and a millisecond cursor compared against microseconds silently skipped them across page boundaries.
 */
function decodeFindingCursor(cursor?: string): { rank: number; at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [rank, at, id] = raw.split('|');
    if (!id || Number.isNaN(Number(rank)) || !at || !/^\d{4}-\d\d-\d\d[ T][\d:.]+([+-]\d\d(:\d\d)?|Z)?$/.test(at)) throw new Error('bad');
    return { rank: Number(rank), at, id };
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'bad cursor');
  }
}

export async function scanningRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:scanning enter');

  // ---- Ingestion: §2 envelope → run + normalized findings (dwight S5-D3) ----

  app.post(
    '/scans/:scanId/findings',
    { preHandler: requirePermission('scan.ingest') },
    async (req, reply) => {
      const scanId = (req.params as { scanId: string }).scanId;
      const body = req.body as Record<string, unknown>;

      // Validate envelope metadata separately so per-finding failures can be
      // partially accepted (SCANNING-CONVENTIONS §4: respond with accepted/
      // rejected fingerprints rather than all-or-nothing).
      const meta = scanEnvelope.omit({ findings: true }).safeParse(body);
      if (!meta.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid scan envelope', meta.error.flatten());
      }
      if (meta.data.scan_id !== scanId) {
        throw new ApiError('VALIDATION_ERROR', 'scan_id in body does not match URL');
      }
      const env = meta.data as ScanEnvelope;

      const scope = await resolveProjectScope(deps.pool, env.project_id);
      await assertScope(
        req,
        { orgId: scope.orgId, projectId: scope.projectId, environmentId: env.environment_id ?? null },
        'finding.ingest',
        'scan.ingest'
      );

      const rawFindings = Array.isArray(body.findings) ? body.findings : [];
      const accepted: FindingInput[] = [];
      const rejected: string[] = [];
      for (const f of rawFindings as unknown[]) {
        const parsed = findingInput.safeParse(f);
        if (parsed.success) accepted.push(parsed.data);
        else if (typeof (f as { finding_fingerprint?: unknown })?.finding_fingerprint === 'string')
          rejected.push((f as { finding_fingerprint: string }).finding_fingerprint);
        else rejected.push(`<unknown:${rejected.length}>`);
      }

      const key = req.headers['idempotency-key'];
      // Keys are per caller: a replay must never return another actor's cached response.
      const idemEndpoint = `${ENDPOINT}:${req.actor!.user.id}`;
      const fp = fingerprint(body);

      const result = await withTx(deps.pool, async (tx) => {
        if (typeof key === 'string' && key.length > 0) {
          const reserved = await tx.query<{ request_fingerprint: string; response_body: unknown }>(
            `INSERT INTO api_idempotency_keys (endpoint, key, request_fingerprint, status_code, response_body)
             VALUES ($1, $2, $3, 202, 'null'::jsonb)
             ON CONFLICT (endpoint, key) DO NOTHING
             RETURNING request_fingerprint, response_body`,
            [idemEndpoint, key, fp]
          );
          if (reserved.rowCount === 0) {
            const existing = await tx.query<{ status_code: number; request_fingerprint: string; response_body: IngestResultDto }>(
              'SELECT status_code, request_fingerprint, response_body FROM api_idempotency_keys WHERE endpoint = $1 AND key = $2',
              [idemEndpoint, key]
            );
            const row = existing.rows[0];
            if (!row) throw new ApiError('CONFLICT', 'idempotency key in flight');
            if (row.request_fingerprint !== fp) {
              throw new ApiError('CONFLICT', 'idempotency key reused with a different request body');
            }
            reply.header('Idempotency-Replayed', 'true');
            return { replay: row.response_body };
          }
        }

        const run = await tx.query<{ id: string }>(
          `INSERT INTO api_scan_runs
             (scan_id, project_id, environment_id, tool_name, tool_version, image_digest,
              target_kind, target_ref, target_branch, started_at, finished_at, status, error_summary, raw_artifact_path, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                   $10::timestamptz, $11::timestamptz, $12, $13, $14, now())
           ON CONFLICT (project_id, scan_id) DO UPDATE SET
             environment_id   = EXCLUDED.environment_id,
             tool_version     = EXCLUDED.tool_version,
             image_digest     = EXCLUDED.image_digest,
             target_kind      = EXCLUDED.target_kind,
             target_ref       = EXCLUDED.target_ref,
             target_branch    = EXCLUDED.target_branch,
             started_at       = EXCLUDED.started_at,
             finished_at      = EXCLUDED.finished_at,
             status           = EXCLUDED.status,
             error_summary    = EXCLUDED.error_summary,
             raw_artifact_path= EXCLUDED.raw_artifact_path,
             updated_at       = now()
           RETURNING id::text`,
          [
            env.scan_id,
            env.project_id,
            env.environment_id ?? null,
            env.tool.name,
            env.tool.version ?? null,
            env.tool.image_digest ?? null,
            env.target.kind ?? null,
            env.target.ref ?? null,
            env.target.branch ?? null,
            env.started_at ?? null,
            env.finished_at ?? null,
            env.status,
            env.error_summary ?? null,
            env.raw_artifact_path ?? null,
          ]
        );
        const runId = run.rows[0]!.id;
        const newCritical: { id: string; title: string; ruleId: string | null }[] = [];

        // One multi-row upsert per chunk instead of a round trip per finding (a large trivy scan is thousands).
        // Duplicate fingerprints inside one statement would hit "cannot affect row a second time": last one wins.
        const uniq = new Map<string, FindingInput>();
        for (const f of accepted) uniq.set(f.finding_fingerprint, f);
        const CAST = new Map([[16, '::jsonb'], [18, '::jsonb'], [19, '::jsonb'], [20, '::jsonb'], [21, '::jsonb']]);
        const all = [...uniq.values()];
        for (let i = 0; i < all.length; i += 200) {
          const chunk = all.slice(i, i + 200);
          const params: unknown[] = [];
          const tuples = chunk.map((f) => {
            const base = params.length;
            params.push(
              runId,
              env.project_id,
              env.environment_id ?? null,
              f.finding_fingerprint,
              f.rule_id ?? null,
              f.title,
              f.description ?? null,
              f.severity,
              f.native_severity ?? null,
              f.confidence,
              env.tool.name,
              env.tool.version ?? null,
              env.tool.image_digest ?? null,
              env.target.ref ?? null,
              env.target.branch ?? null,
              f.location === undefined || f.location === null ? null : JSON.stringify(f.location),
              f.evidence ?? null,
              f.remediation === undefined ? null : JSON.stringify(f.remediation),
              f.cve_ids === undefined ? null : JSON.stringify(f.cve_ids),
              f.advisory_ids === undefined ? null : JSON.stringify(f.advisory_ids),
              f.metadata === undefined ? null : JSON.stringify(f.metadata),
              env.raw_artifact_path ?? null
            );
            const ph = Array.from({ length: 22 }, (_, k) => `$${base + k + 1}${CAST.get(k + 1) ?? ''}`);
            return `(${ph.join(',')}, now(), now())`;
          });
          const inserted = await tx.query<{ id: string; finding_fingerprint: string; inserted: boolean }>(
            `INSERT INTO api_scan_findings
               (scan_run_id, project_id, environment_id, finding_fingerprint, rule_id, title,
                description, severity, native_severity, confidence, scanner, scanner_version,
                image_digest, target_ref, target_branch, location, evidence, remediation,
                cve_ids, advisory_ids, metadata, raw_artifact_path, first_seen_at, last_seen_at)
             VALUES ${tuples.join(',')}
             ON CONFLICT (project_id, finding_fingerprint) DO UPDATE SET
               scan_run_id     = EXCLUDED.scan_run_id,
               environment_id  = EXCLUDED.environment_id,
               rule_id         = EXCLUDED.rule_id,
               title           = EXCLUDED.title,
               description     = EXCLUDED.description,
               severity        = EXCLUDED.severity,
               native_severity = EXCLUDED.native_severity,
               confidence      = EXCLUDED.confidence,
               scanner         = EXCLUDED.scanner,
               scanner_version = EXCLUDED.scanner_version,
               image_digest    = EXCLUDED.image_digest,
               target_ref      = EXCLUDED.target_ref,
               target_branch   = EXCLUDED.target_branch,
               location        = EXCLUDED.location,
               evidence        = EXCLUDED.evidence,
               remediation     = EXCLUDED.remediation,
               cve_ids         = EXCLUDED.cve_ids,
               advisory_ids    = EXCLUDED.advisory_ids,
               metadata        = EXCLUDED.metadata,
               raw_artifact_path = EXCLUDED.raw_artifact_path,
               last_seen_at    = now()
               -- triaged columns (status/assigned_*/remediation_status/resolved_at) preserved
             RETURNING id::text, finding_fingerprint, (xmax = 0) AS inserted`,
            params
          );
          for (const row of inserted.rows) {
            const f = uniq.get(row.finding_fingerprint);
            if (row.inserted && f?.severity === 'critical') {
              newCritical.push({ id: row.id, title: f.title, ruleId: f.rule_id ?? null });
            }
          }
        }

        const dto: IngestResultDto = {
          scanId: env.scan_id,
          runId,
          accepted: accepted.length,
          rejected: rejected.length,
          rejectedFingerprints: rejected,
          runStatus: env.status,
        };
        if (typeof key === 'string' && key.length > 0) {
          await tx.query(
            'UPDATE api_idempotency_keys SET status_code = 202, response_body = $3 WHERE endpoint = $1 AND key = $2',
            [idemEndpoint, key, JSON.stringify(dto)]
          );
        }
        return { dto, newCritical };
      });

      if ('replay' in result) return reply.status(202).send(ok(result.replay));

      // S9 call site: alert on newly-discovered critical findings only (not
      // re-seen ones) — post-commit, so a notification failure never rolls
      // back accepted findings.
      for (let i = 0; i < result.newCritical.length; i += 10) {
        await Promise.all(
          result.newCritical.slice(i, i + 10).map((nc) =>
            enqueueCriticalFindingAlerts(deps.pool, deps.scheduler, {
              id: nc.id,
              projectId: env.project_id,
              title: nc.title,
              ruleId: nc.ruleId,
              targetRef: env.target.ref ?? null,
            })
          )
        );
      }

      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'finding.ingest',
        result: 'allow',
        orgId: scope.orgId,
        projectId: scope.projectId,
        environmentId: env.environment_id ?? null,
        resource: `scan:${env.scan_id}`,
        requestId: req.id,
        details: { accepted: result.dto.accepted, rejected: result.dto.rejected },
      });
      return reply.status(202).send(ok(result.dto));
    }
  );

  // ---- Findings list (portal; angela S5-D5) ----

  app.get('/findings', { preHandler: requirePermission('finding.read') }, async (req) => {
    const parsed = findingListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid query', parsed.error.flatten());
    }
    const q = parsed.data;
    if (!q.projectId && !q.orgId) {
      throw new ApiError('VALIDATION_ERROR', 'projectId or orgId query parameter is required');
    }

    let orgId: string;
    let scopeFilter: string;
    const params: unknown[] = [];
    if (q.projectId) {
      const scope = await resolveProjectScope(deps.pool, q.projectId);
      orgId = scope.orgId;
      await assertScope(req, { orgId, projectId: q.projectId, environmentId: q.environmentId ?? null }, 'finding.list', 'finding.read');
      params.push(q.projectId);
      scopeFilter = 'f.project_id = $1::uuid';
    } else {
      orgId = q.orgId!;
      await assertScope(req, { orgId }, 'finding.list', 'finding.read');
      params.push(orgId);
      scopeFilter = 'f.project_id IN (SELECT id FROM api_projects WHERE org_id = $1::uuid)';
    }

    const where: string[] = [scopeFilter];
    if (q.environmentId) {
      params.push(q.environmentId);
      where.push(`f.environment_id = $${params.length}::uuid`);
    }
    if (q.severity && q.severity.length) {
      params.push(q.severity);
      where.push(`f.severity = ANY($${params.length}::text[])`);
    }
    if (q.status && q.status.length) {
      params.push(q.status);
      where.push(`f.status = ANY($${params.length}::text[])`);
    }
    if (q.scanner) {
      params.push(q.scanner);
      where.push(`f.scanner = $${params.length}`);
    }
    if (q.ruleId) {
      params.push(q.ruleId);
      where.push(`f.rule_id = $${params.length}`);
    }
    if (q.assignedTo) {
      params.push(q.assignedTo);
      where.push(`f.assigned_to = $${params.length}::uuid`);
    }
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(f.title ILIKE $${params.length} OR f.description ILIKE $${params.length})`);
    }

    const limit = q.limit ?? 50;
    const cur = decodeFindingCursor(q.cursor);
    if (cur) {
      where.push(
        `(f.severity_rank > $${params.length + 1} OR (f.severity_rank = $${params.length + 1} AND (f.created_at < $${params.length + 2}::timestamptz OR (f.created_at = $${params.length + 2}::timestamptz AND f.id < $${params.length + 3}::uuid))))`
      );
      params.push(cur.rank, cur.at, cur.id);
    }
    params.push(limit + 1);
    const limitIdx = params.length;

    const rows = await deps.pool.query<FindingRow & { severity_rank: number; created_at_full: string }>(
      `SELECT f.*, f.created_at::text AS created_at_full
       FROM api_scan_findings f
       WHERE ${where.join(' AND ')}
       ORDER BY f.severity_rank ASC, f.created_at DESC, f.id DESC
       LIMIT $${limitIdx}`,
      params
    );
    const items = rows.rows.slice(0, limit).map(toFindingDto);
    let nextCursor: string | null = null;
    if (rows.rows.length > limit) {
      const last = rows.rows[limit - 1]!;
      nextCursor = Buffer.from(`${last.severity_rank}|${last.created_at_full}|${last.id}`).toString('base64url');
    }
    const page: Page<FindingDto> = { items, nextCursor };
    return ok(page);
  });

  // ---- Finding detail ----

  app.get('/findings/:id', { preHandler: requirePermission('finding.read') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await deps.pool.query<FindingRow>(
      'SELECT * FROM api_scan_findings WHERE id = $1',
      [id]
    );
    const r = row.rows[0];
    if (!r) throw new ApiError('NOT_FOUND', `finding ${id} not found`);
    const scope = await resolveProjectScope(deps.pool, r.project_id);
    await assertScope(req, { orgId: scope.orgId, projectId: r.project_id, environmentId: r.environment_id }, 'finding.read', 'finding.read');
    return ok(toFindingDto(r));
  });

  // ---- Finding lifecycle mutation (triage) ----

  app.patch('/findings/:id', { preHandler: requirePermission('finding.update') }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = findingUpdateInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const patch = parsed.data;

    const existing = await deps.pool.query<FindingRow>(
      'SELECT * FROM api_scan_findings WHERE id = $1',
      [id]
    );
    const r = existing.rows[0];
    if (!r) throw new ApiError('NOT_FOUND', `finding ${id} not found`);
    const scope = await resolveProjectScope(deps.pool, r.project_id);
    await assertScope(req, { orgId: scope.orgId, projectId: r.project_id, environmentId: r.environment_id }, 'finding.update', 'finding.update');

    let assignedTo: string | null | undefined = undefined;
    if (patch.assignedTo !== undefined) {
      if (patch.assignedTo === null) {
        assignedTo = null;
      } else {
        const u = await deps.pool.query<{ id: string }>(
          'SELECT id::text FROM api_users WHERE id = $1 AND is_active = true',
          [patch.assignedTo]
        );
        if (!u.rows[0]) throw new ApiError('NOT_FOUND', `assignee ${patch.assignedTo} not found`);
        assignedTo = patch.assignedTo;
      }
    }

    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    const changes: Record<string, unknown> = {};

    if (patch.status !== undefined) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
      // resolved/closed states stamp resolved_at; reopening clears it.
      if (['resolved', 'false_positive', 'dismissed'].includes(patch.status)) {
        sets.push('resolved_at = now()');
      } else {
        sets.push('resolved_at = NULL');
      }
      changes.status = patch.status;
    }
    if (patch.remediationStatus !== undefined) {
      params.push(patch.remediationStatus);
      sets.push(`remediation_status = $${params.length}`);
      changes.remediationStatus = patch.remediationStatus;
    }
    if (assignedTo !== undefined) {
      params.push(assignedTo);
      sets.push(`assigned_to = $${params.length}::uuid`);
      sets.push(`assigned_by = $${params.length + 1}::uuid`);
      sets.push(`assigned_at = now()`);
      params.push(req.actor!.user.id);
      changes.assignedTo = assignedTo;
    }

    if (Object.keys(changes).length === 0) {
      return ok(toFindingDto(r));
    }

    const updated = await deps.pool.query<FindingRow>(
      `UPDATE api_scan_findings SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    await recordAudit(deps.pool, {
      actorId: req.actor!.user.id,
      action: 'finding.update',
      result: 'allow',
      orgId: scope.orgId,
      projectId: r.project_id,
      environmentId: r.environment_id,
      resource: `finding:${id}`,
      requestId: req.id,
      details: changes,
    });
    return ok(toFindingDto(updated.rows[0]!));
  });

  // ---- Scan runs ----

  function runCountsAgg(): string {
    return `(SELECT jsonb_build_object(
        'critical', count(*) FILTER (WHERE severity='critical'),
        'high', count(*) FILTER (WHERE severity='high'),
        'medium', count(*) FILTER (WHERE severity='medium'),
        'low', count(*) FILTER (WHERE severity='low'),
        'info', count(*) FILTER (WHERE severity='info'),
        'total', count(*),
        'open', count(*) FILTER (WHERE status='open')
      ) FROM api_scan_findings f WHERE f.scan_run_id = r.id) AS finding_counts`;
  }

  type RunRow = {
    id: string;
    scan_id: string;
    project_id: string;
    environment_id: string | null;
    tool_name: string;
    tool_version: string | null;
    image_digest: string | null;
    target_kind: string | null;
    target_ref: string | null;
    target_branch: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    status: 'completed' | 'failed' | 'partial';
    error_summary: string | null;
    raw_artifact_path: string | null;
    created_at: Date;
    updated_at: Date;
    finding_counts: {
      critical: number; high: number; medium: number; low: number; info: number; total: number; open: number;
    };
  };

  function toRunDto(r: RunRow): ScanRunDto {
    const c = r.finding_counts;
    return {
      id: r.id,
      scanId: r.scan_id,
      projectId: r.project_id,
      environmentId: r.environment_id,
      tool: { name: r.tool_name, version: r.tool_version, imageDigest: r.image_digest },
      target: { kind: (r.target_kind as ScanRunDto['target']['kind']) ?? null, ref: r.target_ref, branch: r.target_branch },
      startedAt: r.started_at ? r.started_at.toISOString() : null,
      finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
      status: r.status,
      errorSummary: r.error_summary,
      rawArtifactPath: r.raw_artifact_path,
      findingCounts: {
        critical: c.critical, high: c.high, medium: c.medium, low: c.low, info: c.info,
        total: c.total, open: c.open,
      },
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  app.get('/scans', { preHandler: requirePermission('finding.read') }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const projectId = typeof q.projectId === 'string' ? q.projectId : undefined;
    const orgIdQ = typeof q.orgId === 'string' ? q.orgId : undefined;
    const envId = typeof q.environmentId === 'string' ? q.environmentId : undefined;
    if (!projectId && !orgIdQ) {
      throw new ApiError('VALIDATION_ERROR', 'projectId or orgId query parameter is required');
    }
    let orgId: string;
    const where: string[] = [];
    const params: unknown[] = [];
    if (projectId) {
      const scope = await resolveProjectScope(deps.pool, projectId);
      orgId = scope.orgId;
      await assertScope(req, { orgId, projectId, environmentId: envId ?? null }, 'scan.list', 'finding.read');
      params.push(projectId);
      where.push('r.project_id = $1::uuid');
    } else {
      orgId = orgIdQ!;
      await assertScope(req, { orgId }, 'scan.list', 'finding.read');
      params.push(orgId);
      where.push('r.project_id IN (SELECT id FROM api_projects WHERE org_id = $1::uuid)');
    }
    if (envId) {
      params.push(envId);
      where.push(`r.environment_id = $${params.length}::uuid`);
    }

    const limit = typeof q.limit === 'string' && /^\d+$/.test(q.limit) ? Number(q.limit) : 50;
    const cur = typeof q.cursor === 'string' && q.cursor ? decodeRunCursor(q.cursor) : null;
    if (cur) {
      where.push(`(date_trunc('milliseconds', r.created_at), r.id) < ($${params.length + 1}::timestamptz, $${params.length + 2}::uuid)`);
      params.push(cur.at.toISOString(), cur.id);
    }
    params.push(limit + 1);
    const limitIdx = params.length;

    const rows = await deps.pool.query<RunRow>(
      `SELECT r.*, ${runCountsAgg()}
       FROM api_scan_runs r
       WHERE ${where.join(' AND ')}
       ORDER BY date_trunc('milliseconds', r.created_at) DESC, r.id DESC LIMIT $${limitIdx}`,
      params
    );
    const items = rows.rows.slice(0, limit).map(toRunDto);
    let nextCursor: string | null = null;
    if (rows.rows.length > limit) {
      const last = rows.rows[limit - 1]!;
      nextCursor = Buffer.from(`${last.created_at.getTime()}|${last.id}`).toString('base64url');
    }
    const page: Page<ScanRunDto> = { items, nextCursor };
    return ok(page);
  });

  function decodeRunCursor(cursor: string): { at: Date; id: string } | null {
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const [atMs, id] = raw.split('|');
      const at = new Date(Number(atMs));
      if (!id || Number.isNaN(at.getTime())) throw new Error('bad');
      return { at, id };
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'bad cursor');
    }
  }

  app.get('/scans/:scanId', { preHandler: requirePermission('finding.read') }, async (req) => {
    const { scanId } = req.params as { scanId: string };
    const { projectId } = req.query as { projectId?: string };
    // scan_id is only unique per project: consider every match, return one the caller may read, and answer 404 for the
    // rest so a foreign scan's existence isn't revealed.
    const rows = await deps.pool.query<RunRow>(
      `SELECT r.*, ${runCountsAgg()} FROM api_scan_runs r
        WHERE r.scan_id = $1 AND ($2::uuid IS NULL OR r.project_id = $2::uuid)
        ORDER BY r.created_at DESC LIMIT 20`,
      [scanId, projectId && isUuid(projectId) ? projectId : null]
    );
    for (const r of rows.rows) {
      const scope = await resolveProjectScope(deps.pool, r.project_id);
      if (can(req.actor!.bindings, { orgId: scope.orgId, projectId: r.project_id, environmentId: r.environment_id }, 'finding.read')) {
        return ok(toRunDto(r));
      }
    }
    throw new ApiError('NOT_FOUND', `scan ${scanId} not found`);
  });

  console.log('[boot] plugin:scanning exit');
}
