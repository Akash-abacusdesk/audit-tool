import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  ApiError,
  isUuid,
  ok,
  type Page,
  type GitBranchDto,
  type GitCommitDto,
  type GitConnectionDto,
  type GitPullRequestDto,
  type GitProvider,
  type GitSyncResultDto,
  type PolicyAssignmentDto,
  type RepoLinkDto,
  type StackDetectionDto,
  type StackKind,
  connectionCreateInput,
  policyAssignmentCreateInput,
  repoLinkCreateInput,
  stackDetectionRecordInput,
} from '@platform/shared';
import { z } from 'zod';
import { recordAudit } from '../auth/audit.js';
import { assertScope, requirePermission } from '../auth/service.js';
import { storeCredential, syncRepoLink } from '../git/sync.js';

interface Deps {
  pool: Pool;
}

type ConnectionRow = {
  id: string;
  org_id: string;
  provider: GitProvider;
  display_name: string | null;
  external_account_id: string | null;
  status: GitConnectionDto['status'];
  created_by: string;
  created_at: Date;
};

function toConnectionDto(r: ConnectionRow): GitConnectionDto {
  return {
    id: r.id,
    orgId: r.org_id,
    provider: r.provider,
    displayName: r.display_name,
    externalAccountId: r.external_account_id,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

type RepoLinkRow = {
  id: string;
  org_id: string;
  project_id: string;
  connection_id: string;
  provider: GitProvider;
  external_repo_id: string;
  full_name: string;
  default_branch: string;
  created_at: Date;
};

function toRepoLinkDto(r: RepoLinkRow): RepoLinkDto {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    connectionId: r.connection_id,
    provider: r.provider,
    externalRepoId: r.external_repo_id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    createdAt: r.created_at.toISOString(),
  };
}

type StackRow = {
  id: string;
  project_id: string;
  environment_id: string | null;
  stacks: StackKind[];
  headless: boolean;
  evidence: unknown;
  source_commit_sha: string | null;
  detector_version: string;
  detected_at: Date;
};

function toStackDto(r: StackRow): StackDetectionDto {
  return {
    id: r.id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    stacks: r.stacks,
    headless: r.headless,
    evidence: r.evidence,
    sourceCommitSha: r.source_commit_sha,
    detectorVersion: r.detector_version,
    detectedAt: r.detected_at.toISOString(),
  };
}

type PolicyRow = {
  id: string;
  policy_id: string;
  org_id: string;
  project_id: string | null;
  environment_id: string | null;
  enabled: boolean;
  created_by: string;
  created_at: Date;
};

function toPolicyDto(r: PolicyRow): PolicyAssignmentDto {
  return {
    id: r.id,
    policyId: r.policy_id,
    orgId: r.org_id,
    projectId: r.project_id,
    environmentId: r.environment_id,
    enabled: r.enabled,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

/** Shared "(created_at,id)" keyset page for list endpoints below.
 *  whereAnd: predicate fragments (ANDed); params: their values in order.
 *  qualifier: table alias prefix ('' or e.g. 'l.') REQUIRED when selectFrom
 *  joins tables that both have created_at/id (PG 42702 otherwise). */
async function keysetPage<T extends { id: string }>(
  pool: Pool,
  selectFrom: string,
  whereAnd: string[],
  params: unknown[],
  cursor: { at: Date; id: string } | null,
  limit: number,
  qualifier = ''
): Promise<{ rows: T[]; nextCursor: string | null }> {
  const curAtIdx = params.length + 1;
  const curIdIdx = params.length + 2;
  const limitIdx = params.length + 3;
  const q = qualifier;
  const clauses = [
    ...whereAnd,
    `($${curAtIdx}::timestamptz IS NULL OR (${q}created_at, ${q}id) < ($${curAtIdx}::timestamptz, $${curIdIdx}::uuid))`,
  ];
  const rows = await pool.query<T & { created_at: Date }>(
    `${selectFrom}
     WHERE ${clauses.join(' AND ')}
     ORDER BY ${q}created_at DESC, ${q}id DESC LIMIT $${limitIdx}`,
    [...params, cursor ? cursor.at.toISOString() : null, cursor?.id ?? null, limit + 1]
  );
  const items = rows.rows.slice(0, limit);
  let nextCursor: string | null = null;
  if (rows.rows.length > limit) {
    const last = items[limit - 1]!;
    nextCursor = Buffer.from(`${last.created_at.getTime()}|${last.id}`).toString('base64url');
  }
  return { rows: items as T[], nextCursor };
}

interface ListQuery {
  orgId?: string;
  projectId?: string;
  connectionId?: string;
  limit?: number;
  cursor?: string;
}

const gitListQuery = {
  safeParse(q: unknown) {
    const d = { ...(q as ListQuery) };
    // query params arrive as strings; coerce numeric limit before validation
    if (typeof d.limit === 'string' && /^\d+$/.test(d.limit)) d.limit = Number(d.limit);
    const bad = (): boolean =>
      (d.limit !== undefined && (typeof d.limit !== 'number' || d.limit < 1 || d.limit > 200)) ||
      (d.cursor !== undefined && typeof d.cursor !== 'string') ||
      [d.orgId, d.projectId, d.connectionId].some((v) => v !== undefined && !/^[0-9a-f-]{36}$/i.test(v));
    return { success: !bad(), data: d, error: { flatten: () => ({}) } } as const;
  },
};

function decodeCursor(cursor?: string): { at: Date; id: string } | null {
  if (!cursor) return null;
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

export async function gitRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:git enter');

  // ---- git connections (org-scoped) ----

  app.post(
    '/git-connections',
    { preHandler: requirePermission('git.manage') },
    async (req, reply) => {
      const parsed = connectionCreateInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { orgId, provider, displayName } = parsed.data;
      await assertScope(req, { orgId }, 'git.connection.create', 'org.manage');
      try {
        const inserted = await deps.pool.query<ConnectionRow>(
          `INSERT INTO api_git_connections (org_id, provider, display_name, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id::text, org_id::text, provider, display_name, external_account_id, status, created_by::text, created_at`,
          [orgId, provider, displayName ?? null, req.actor!.user.id]
        );
        const dto = toConnectionDto(inserted.rows[0]!);
        await recordAudit(deps.pool, {
          actorId: req.actor!.user.id,
          action: 'git.connection.create',
          result: 'allow',
          orgId,
          resource: `git-connection:${dto.id}`,
          requestId: req.id,
        });
        return reply.status(201).send(ok(dto));
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new ApiError('CONFLICT', 'connection already exists for this account/provider');
        }
        throw err;
      }
    }
  );

  app.get('/git-connections', { preHandler: requirePermission('git.read') }, async (req) => {
    const parsed = gitListQuery.safeParse(req.query);
    if (!parsed.success || !parsed.data.orgId) {
      throw new ApiError('VALIDATION_ERROR', 'orgId query parameter is required');
    }
    const { orgId, limit = 50, cursor } = parsed.data;
    await assertScope(req, { orgId }, 'git.connection.list', 'git.read');
    const cur = decodeCursor(cursor);
    const { rows, nextCursor } = await keysetPage<ConnectionRow>(
      deps.pool,
      `SELECT id::text, org_id::text, provider, display_name, external_account_id, status, created_by::text, created_at
       FROM api_git_connections`,
      ['org_id = $1::uuid'],
      [orgId],
      cur,
      limit
    );
    const page: Page<GitConnectionDto> = {
      items: rows.map(toConnectionDto),
      nextCursor,
    };
    return ok(page);
  });

  app.delete('/git-connections/:id', { preHandler: requirePermission('git.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const found = await deps.pool.query<Pick<ConnectionRow, 'id' | 'org_id'>>(
      'SELECT id::text, org_id::text FROM api_git_connections WHERE id = $1',
      [id]
    );
    const row = found.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', `git-connection ${id} not found`);
    await assertScope(req, { orgId: row.org_id }, 'git.connection.revoke', 'org.manage');
    // Soft revoke — webhook history FKs stay intact; the row stops being usable.
    const updated = await deps.pool.query<ConnectionRow>(
      `UPDATE api_git_connections SET status = 'revoked' WHERE id = $1
       RETURNING id::text, org_id::text, provider, display_name, external_account_id, status, created_by::text, created_at`,
      [id]
    );
    await recordAudit(deps.pool, {
      actorId: req.actor!.user.id,
      action: 'git.connection.revoke',
      result: 'allow',
      orgId: row.org_id,
      resource: `git-connection:${id}`,
      requestId: req.id,
    });
    return ok(toConnectionDto(updated.rows[0]!));
  });

  // ---- repo links (project-scoped) ----

  app.post(
    '/repo-links',
    { preHandler: requirePermission('project.manage') },
    async (req, reply) => {
      const parsed = repoLinkCreateInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { projectId, connectionId, externalRepoId, fullName, defaultBranch } = parsed.data;
      const proj = await deps.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM api_projects WHERE id = $1',
        [projectId]
      );
      const orgId = proj.rows[0]?.org_id;
      if (!orgId) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
      await assertScope(req, { orgId, projectId }, 'git.repo.link', 'project.manage');
      try {
        const inserted = await deps.pool.query<RepoLinkRow>(
          `INSERT INTO api_repo_links (org_id, project_id, connection_id, external_repo_id, full_name, default_branch)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id::text, org_id::text, project_id::text, connection_id::text,
                     (SELECT provider FROM api_git_connections c WHERE c.id = api_repo_links.connection_id) AS provider,
                     external_repo_id, full_name, default_branch, created_at`,
          [orgId, projectId, connectionId, externalRepoId, fullName, defaultBranch]
        );
        const dto = toRepoLinkDto(inserted.rows[0]!);
        await recordAudit(deps.pool, {
          actorId: req.actor!.user.id,
          action: 'git.repo.link',
          result: 'allow',
          orgId,
          projectId,
          resource: `repo-link:${dto.id}`,
          requestId: req.id,
          details: { fullName },
        });
        return reply.status(201).send(ok(dto));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') throw new ApiError('CONFLICT', 'repo already linked to this connection');
        if (code === '23503') throw new ApiError('NOT_FOUND', 'connection or project does not exist');
        throw err;
      }
    }
  );

  app.get('/repo-links', { preHandler: requirePermission('git.read') }, async (req) => {
    const parsed = gitListQuery.safeParse(req.query);
    if (!parsed.success || !parsed.data.projectId) {
      throw new ApiError('VALIDATION_ERROR', 'projectId query parameter is required');
    }
    const { projectId, limit = 50, cursor } = parsed.data;
    const proj = await deps.pool.query<{ org_id: string }>(
      'SELECT org_id::text FROM api_projects WHERE id = $1',
      [projectId]
    );
    const orgId = proj.rows[0]?.org_id;
    if (!orgId) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
    await assertScope(req, { orgId, projectId }, 'git.repo.list', 'git.read');
    const cur = decodeCursor(cursor);
    const { rows, nextCursor } = await keysetPage<RepoLinkRow>(
      deps.pool,
      `SELECT l.id::text, l.org_id::text, l.project_id::text, l.connection_id::text, c.provider,
              l.external_repo_id, l.full_name, l.default_branch, l.created_at
       FROM api_repo_links l JOIN api_git_connections c ON c.id = l.connection_id`,
      ['l.project_id = $1::uuid'],
      [projectId],
      cur,
      limit,
      'l.'
    );
    const page: Page<RepoLinkDto> = { items: rows.map(toRepoLinkDto), nextCursor };
    return ok(page);
  });

  // ---- stack detections (kevin's detector output, project-scoped) ----

  app.post(
    '/stack-detections',
    { preHandler: requirePermission('git.manage') },
    async (req, reply) => {
      const parsed = stackDetectionRecordInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { projectId, environmentId, stacks, headless, evidence, sourceCommitSha, detectorVersion } =
        parsed.data;
      const proj = await deps.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM api_projects WHERE id = $1',
        [projectId]
      );
      const orgId = proj.rows[0]?.org_id;
      if (!orgId) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
      await assertScope(req, { orgId, projectId, environmentId: environmentId ?? null }, 'git.stack.record', 'project.manage');
      const inserted = await deps.pool.query<StackRow>(
        `INSERT INTO api_stack_detections (project_id, environment_id, stacks, headless, evidence, source_commit_sha, detector_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id::text, project_id::text, environment_id::text, stacks, headless, evidence, source_commit_sha, detector_version, detected_at`,
        [
          projectId,
          environmentId ?? null,
          stacks,
          headless,
          evidence === undefined ? null : JSON.stringify(evidence),
          sourceCommitSha ?? null,
          detectorVersion,
        ]
      );
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'git.stack.record',
        result: 'allow',
        orgId,
        projectId,
        environmentId: environmentId ?? null,
        resource: `stack-detection:${inserted.rows[0]!.id}`,
        requestId: req.id,
        details: { stacks },
      });
      return reply.status(201).send(ok(toStackDto(inserted.rows[0]!)));
    }
  );

  app.get('/stack-detections', { preHandler: requirePermission('git.read') }, async (req) => {
    const parsed = gitListQuery.safeParse(req.query);
    if (!parsed.success || !parsed.data.projectId) {
      throw new ApiError('VALIDATION_ERROR', 'projectId query parameter is required');
    }
    const { projectId, limit = 50 } = parsed.data;
    const proj = await deps.pool.query<{ org_id: string }>(
      'SELECT org_id::text FROM api_projects WHERE id = $1',
      [projectId]
    );
    const orgId = proj.rows[0]?.org_id;
    if (!orgId) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
    await assertScope(req, { orgId, projectId }, 'git.stack.list', 'git.read');
    // Latest-first window; no cursor — portal shows recent history only.
    const rows = await deps.pool.query<StackRow>(
      `SELECT id::text, project_id::text, environment_id::text, stacks, headless, evidence,
              source_commit_sha, detector_version, detected_at
       FROM api_stack_detections WHERE project_id = $1::uuid
       ORDER BY detected_at DESC LIMIT $2`,
      [projectId, limit]
    );
    return ok(rows.rows.map(toStackDto));
  });

  // ---- policy assignments (dwight's mapper ↔ RBAC scopes) ----

  app.post(
    '/policy-assignments',
    { preHandler: requirePermission('git.manage') },
    async (req, reply) => {
      const parsed = policyAssignmentCreateInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { policyId, orgId, projectId, environmentId, enabled } = parsed.data;
      await assertScope(
        req,
        { orgId, projectId: projectId ?? null, environmentId: environmentId ?? null },
        'git.policy.assign',
        'project.manage'
      );
      try {
        const inserted = await deps.pool.query<PolicyRow>(
          `INSERT INTO api_policy_assignments (policy_id, org_id, project_id, environment_id, enabled, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id::text, policy_id, org_id::text, project_id::text, environment_id::text, enabled, created_by::text, created_at`,
          [policyId, orgId, projectId ?? null, environmentId ?? null, enabled, req.actor!.user.id]
        );
        await recordAudit(deps.pool, {
          actorId: req.actor!.user.id,
          action: 'git.policy.assign',
          result: 'allow',
          orgId,
          projectId: projectId ?? null,
          environmentId: environmentId ?? null,
          resource: `policy-assignment:${inserted.rows[0]!.id}`,
          requestId: req.id,
          details: { policyId },
        });
        return reply.status(201).send(ok(toPolicyDto(inserted.rows[0]!)));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') throw new ApiError('CONFLICT', 'policy already assigned at this scope');
        if (code === '23503') throw new ApiError('NOT_FOUND', 'scope target does not exist');
        throw err;
      }
    }
  );

  app.get('/policy-assignments', { preHandler: requirePermission('git.read') }, async (req) => {
    const parsed = gitListQuery.safeParse(req.query);
    if (!parsed.success || (!parsed.data.orgId && !parsed.data.projectId)) {
      throw new ApiError('VALIDATION_ERROR', 'orgId or projectId query parameter is required');
    }
    const { orgId, projectId, limit = 50 } = parsed.data;
    let resolvedOrg = orgId ?? null;
    if (!resolvedOrg && projectId) {
      const proj = await deps.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM api_projects WHERE id = $1',
        [projectId]
      );
      resolvedOrg = proj.rows[0]?.org_id ?? null;
      if (!resolvedOrg) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
    }
    await assertScope(
      req,
      { orgId: resolvedOrg!, projectId: projectId ?? null },
      'git.policy.list',
      'git.read'
    );
    const rows = await deps.pool.query<PolicyRow>(
      `SELECT id::text, policy_id, org_id::text, project_id::text, environment_id::text, enabled, created_by::text, created_at
       FROM api_policy_assignments
       WHERE ($1::uuid IS NOT NULL AND org_id = $1::uuid)
          OR ($2::uuid IS NOT NULL AND project_id = $2::uuid)
       ORDER BY created_at DESC LIMIT $3`,
      [resolvedOrg, projectId ?? null, limit]
    );
    return ok(rows.rows.map(toPolicyDto));
  });

  // ---- S3-D1B: provider credentials + repo snapshot sync + reads ----

  const credentialInput = z.object({ token: z.string().min(1).max(500) });

  /** Resolve a repo link to its scope path; 404 when missing. */
  async function requireRepoLink(id: string): Promise<{ orgId: string; projectId: string }> {
    if (!isUuid(id)) throw new ApiError('NOT_FOUND', `repo-link ${id} not found`);
    const r = await deps.pool.query<{ org_id: string; project_id: string }>(
      'SELECT org_id::text, project_id::text FROM api_repo_links WHERE id = $1',
      [id]
    );
    const row = r.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', `repo-link ${id} not found`);
    return { orgId: row.org_id, projectId: row.project_id };
  }

  function parseLimit(q: Record<string, unknown>): number {
    const raw = q.limit;
    if (raw === undefined) return 100;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new ApiError('VALIDATION_ERROR', 'limit must be an integer 1..200');
    }
    return n;
  }

  type BranchRow = { id: string; repo_link_id: string; name: string; head_sha: string | null; updated_at: Date };
  type CommitRow = {
    id: string;
    repo_link_id: string;
    sha: string;
    branch: string;
    author_email: string | null;
    message: string | null;
    committed_at: Date | null;
  };
  type PullRequestRow = {
    id: string;
    repo_link_id: string;
    external_id: string;
    source_branch: string;
    target_branch: string;
    state: GitPullRequestDto['state'];
    title: string | null;
    head_sha: string | null;
    updated_at: Date;
  };

  // Store/rotate the provider token (encrypted at rest, never echoed back).
  app.put(
    '/git-connections/:id/credential',
    { preHandler: requirePermission('git.manage') },
    async (req) => {
      const parsed = credentialInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { id } = req.params as { id: string };
      const found = await deps.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM api_git_connections WHERE id = $1',
        [id]
      );
      const row = found.rows[0];
      if (!row) throw new ApiError('NOT_FOUND', `git-connection ${id} not found`);
      await assertScope(req, { orgId: row.org_id }, 'git.connection.credential.set', 'org.manage');
      try {
        await storeCredential(deps.pool, id, parsed.data.token);
      } catch (err) {
        throw new ApiError('UNAVAILABLE', 'credential storage not configured');
      }
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'git.connection.credential.set',
        result: 'allow',
        orgId: row.org_id,
        resource: `git-connection:${id}`,
        requestId: req.id,
      });
      return ok({ stored: true });
    }
  );

  // Manual sync trigger — fetches from the provider and upserts the snapshot.
  app.post('/repo-links/:id/sync', { preHandler: requirePermission('git.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const scope = await requireRepoLink(id);
    await assertScope(req, { ...scope }, 'git.repo.sync', 'project.manage');
    let result;
    try {
      result = await syncRepoLink(deps.pool, id);
    } catch (err) {
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'git.repo.sync',
        result: 'deny',
        orgId: scope.orgId,
        projectId: scope.projectId,
        resource: `repo-link:${id}`,
        requestId: req.id,
        details: { reason: (err as Error).message },
      });
      throw err;
    }
    await recordAudit(deps.pool, {
      actorId: req.actor!.user.id,
      action: 'git.repo.sync',
      result: 'allow',
      orgId: scope.orgId,
      projectId: scope.projectId,
      resource: `repo-link:${id}`,
      requestId: req.id,
      details: result.counts,
    });
    const dto: GitSyncResultDto = { repoLinkId: id, syncedAt: result.syncedAt.toISOString(), counts: result.counts };
    return ok(dto);
  });

  app.get('/repo-links/:id/branches', { preHandler: requirePermission('git.read') }, async (req) => {
    const { id } = req.params as { id: string };
    const scope = await requireRepoLink(id);
    await assertScope(req, { ...scope }, 'git.branch.list', 'git.read');
    const limit = parseLimit(req.query as Record<string, unknown>);
    const rows = await deps.pool.query<BranchRow>(
      `SELECT id::text, repo_link_id::text, name, head_sha, updated_at
       FROM api_git_branches WHERE repo_link_id = $1 ORDER BY name ASC LIMIT $2`,
      [id, limit]
    );
    const items: GitBranchDto[] = rows.rows.map((r) => ({
      id: r.id,
      repoLinkId: r.repo_link_id,
      name: r.name,
      headSha: r.head_sha,
      updatedAt: r.updated_at.toISOString(),
    }));
    return ok(items);
  });

  app.get('/repo-links/:id/commits', { preHandler: requirePermission('git.read') }, async (req) => {
    const { id } = req.params as { id: string };
    const scope = await requireRepoLink(id);
    await assertScope(req, { ...scope }, 'git.commit.list', 'git.read');
    const q = req.query as Record<string, unknown>;
    const limit = parseLimit(q);
    const branch = typeof q.branch === 'string' && q.branch.length > 0 ? q.branch : null;
    const rows = await deps.pool.query<CommitRow>(
      `SELECT id::text, repo_link_id::text, sha, branch, author_email, message, committed_at
       FROM api_git_commits
       WHERE repo_link_id = $1 AND ($2::text IS NULL OR branch = $2)
       ORDER BY committed_at DESC NULLS LAST LIMIT $3`,
      [id, branch, limit]
    );
    const items: GitCommitDto[] = rows.rows.map((r) => ({
      id: r.id,
      repoLinkId: r.repo_link_id,
      sha: r.sha,
      branch: r.branch,
      authorEmail: r.author_email,
      message: r.message,
      committedAt: r.committed_at ? r.committed_at.toISOString() : '',
    }));
    return ok(items);
  });

  app.get('/repo-links/:id/pull-requests', { preHandler: requirePermission('git.read') }, async (req) => {
    const { id } = req.params as { id: string };
    const scope = await requireRepoLink(id);
    await assertScope(req, { ...scope }, 'git.pr.list', 'git.read');
    const limit = parseLimit(req.query as Record<string, unknown>);
    const rows = await deps.pool.query<PullRequestRow>(
      `SELECT id::text, repo_link_id::text, external_id, source_branch, target_branch, state, title, head_sha, updated_at
       FROM api_git_pull_requests WHERE repo_link_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [id, limit]
    );
    const items: GitPullRequestDto[] = rows.rows.map((r) => ({
      id: r.id,
      repoLinkId: r.repo_link_id,
      externalId: r.external_id,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      state: r.state,
      title: r.title,
      headSha: r.head_sha,
      updatedAt: r.updated_at.toISOString(),
    }));
    return ok(items);
  });
}
