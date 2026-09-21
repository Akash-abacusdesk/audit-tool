import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  ApiError,
  auditListQuery,
  environmentCreateInput,
  listQuery,
  ok,
  orgCreateInput,
  projectCreateInput,
  roleBindingCreateInput,
  userCreateInput,
  userUpdateInput,
  type AuditEventDto,
  type EnvironmentDto,
  type OrgDto,
  type Page,
  type ProjectDto,
  type RoleBindingDto,
  type UserDto,
} from '@platform/shared';
import { hashPassword } from '../auth/passwords.js';
import { buildAuditWhere, recordAudit } from '../auth/audit.js';
import { assertNotSelf, assertScope, requirePermission } from '../auth/service.js';
import { toBindingDto, toUserDto } from './auth.js';
import { withTx } from '../db/pool.js';

interface Deps {
  pool: Pool;
}

/** Decode a base64 cursor "(created_at,id)" into its parts; null when absent. */
function decodeCursor(cursor?: string): { at: Date; id: string } | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [atMs, id] = raw.split('|');
  const at = new Date(Number(atMs));
  if (!id || Number.isNaN(at.getTime())) throw new ApiError('VALIDATION_ERROR', 'bad cursor');
  return { at, id };
}

export async function adminRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:admin enter');
  // ---- users ----

  app.post(
    '/users',
    { preHandler: requirePermission('user.manage') },
    async (req, reply) => {
      const parsed = userCreateInput.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
      }
      const { email, password, displayName } = parsed.data;
      const passwordHash = await hashPassword(password);
      try {
        const inserted = await deps.pool.query<{ id: string; created_at: Date }>(
          `INSERT INTO api_users (email, display_name, password_hash)
           VALUES ($1, $2, $3) RETURNING id::text, created_at`,
          [email.toLowerCase(), displayName, passwordHash]
        );
        const r = inserted.rows[0]!;
        await recordAudit(deps.pool, {
          actorId: req.actor!.user.id,
          action: 'user.create',
          result: 'allow',
          resource: `user:${r.id}`,
          requestId: req.id,
        });
        const dto: UserDto = {
          id: r.id,
          email: email.toLowerCase(),
          displayName,
          isActive: true,
          createdAt: r.created_at.toISOString(),
        };
        return reply.status(201).send(ok(dto));
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new ApiError('CONFLICT', 'email already registered');
        }
        throw err;
      }
    }
  );

  app.get('/users', { preHandler: requirePermission('user.manage') }, async (req) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid query', parsed.error.flatten());
    }
    const limit = parsed.data.limit ?? 50;
    const cur = decodeCursor(parsed.data.cursor);
    const rows = await deps.pool.query<{
      id: string;
      email: string;
      display_name: string;
      is_active: boolean;
      created_at: Date;
    }>(
      `SELECT id::text, email, display_name, is_active, created_at FROM api_users
       WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [cur ? cur.at.toISOString() : null, cur?.id ?? null, limit + 1]
    );
    const items = rows.rows.slice(0, limit).map(toUserDto);
    let nextCursor: string | null = null;
    if (rows.rows.length > limit) {
      const last = rows.rows[limit - 1]!;
      nextCursor = Buffer.from(`${last.created_at.getTime()}|${last.id}`).toString('base64url');
    }
    const page: Page<UserDto> = { items, nextCursor };
    return ok(page);
  });

  app.patch('/users/:id', { preHandler: requirePermission('user.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = userUpdateInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    await assertNotSelf(req, id, 'user.update');
    const found = await deps.pool.query<Parameters<typeof toUserDto>[0]>(
      'SELECT id::text, email, display_name, is_active, created_at FROM api_users WHERE id = $1',
      [id]
    );
    const row = found.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', `user ${id} not found`);

    if (row.is_active !== parsed.data.isActive) {
      await withTx(deps.pool, async (tx) => {
        await tx.query('UPDATE api_users SET is_active = $2 WHERE id = $1', [id, parsed.data.isActive]);
        if (!parsed.data.isActive) {
          // Deactivation kills live sessions immediately.
          await tx.query(
            'UPDATE api_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [id]
          );
        }
        await recordAudit(tx, {
          actorId: req.actor!.user.id,
          action: parsed.data.isActive ? 'user.activate' : 'user.deactivate',
          result: 'allow',
          resource: `user:${id}`,
          requestId: req.id,
          details: { targetEmail: row.email },
        });
      });
    }
    return ok(toUserDto({ ...row, is_active: parsed.data.isActive }));
  });

  // ---- role bindings (scope-checked assignment, no-self rule) ----

  app.post('/role-bindings', { preHandler: requirePermission('role.assign') }, async (req, reply) => {
    const parsed = roleBindingCreateInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const b = parsed.data;
    await assertNotSelf(req, b.userId, 'role.grant');

    // Grantor must hold role.assign exactly at the scope being granted.
    await assertScope(
      req,
      { orgId: b.orgId, projectId: b.projectId ?? null, environmentId: b.environmentId ?? null },
      'role.grant',
      'role.assign'
    );

    if (b.environmentId !== undefined) {
      const parent = await deps.pool.query<{ org_id: string }>(
        `SELECT p.org_id::text FROM api_environments e JOIN api_projects p ON p.id = e.project_id
         WHERE e.id = $1`,
        [b.environmentId]
      );
      if (parent.rows[0]?.org_id !== b.orgId || parent.rows[0]?.org_id === undefined) {
        throw new ApiError('VALIDATION_ERROR', 'environment does not belong to org');
      }
    }

    try {
      const dto = await withTx(deps.pool, async (tx) => {
        const inserted = await tx.query<Parameters<typeof toBindingDto>[0]>(
          `INSERT INTO api_role_bindings (user_id, role, org_id, project_id, environment_id, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${bindingCols}`,
          [
            b.userId,
            b.role,
            b.orgId,
            b.projectId ?? null,
            b.environmentId ?? null,
            req.actor!.user.id,
          ]
        );
        const d = toBindingDto(inserted.rows[0]!);
        await recordAudit(tx, {
          actorId: req.actor!.user.id,
          action: 'role.grant',
          result: 'allow',
          orgId: d.orgId,
          projectId: d.projectId,
          environmentId: d.environmentId,
          resource: `role-binding:${d.id}`,
          requestId: req.id,
          details: { targetUserId: d.userId, role: d.role },
        });
        return d;
      });
      return reply.status(201).send(ok(dto));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError('CONFLICT', 'identical binding already exists');
      }
      if ((err as { code?: string }).code === '23503') {
        throw new ApiError('VALIDATION_ERROR', 'unknown user/org/project/environment reference');
      }
      throw err;
    }
  });

  app.delete('/role-bindings/:id', { preHandler: requirePermission('role.assign') }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await deps.pool.query<Parameters<typeof toBindingDto>[0]>(
      `SELECT ${bindingCols} FROM api_role_bindings WHERE id = $1`,
      [id]
    );
    const binding = existing.rows[0];
    if (!binding) throw new ApiError('NOT_FOUND', `role binding ${id} not found`);
    await assertNotSelf(req, binding.user_id, 'role.revoke');
    await assertScope(
      req,
      {
        orgId: binding.org_id,
        projectId: binding.project_id,
        environmentId: binding.environment_id,
      },
      'role.revoke',
      'role.assign'
    );

    await withTx(deps.pool, async (tx) => {
      await tx.query('DELETE FROM api_role_bindings WHERE id = $1', [id]);
      await recordAudit(tx, {
        actorId: req.actor!.user.id,
        action: 'role.revoke',
        result: 'allow',
        orgId: binding.org_id,
        projectId: binding.project_id,
        environmentId: binding.environment_id,
        resource: `role-binding:${binding.id}`,
        requestId: req.id,
        details: { targetUserId: binding.user_id, role: binding.role },
      });
    });
    const dto: RoleBindingDto = toBindingDto(binding);
    return ok(dto);
  });

  // ---- scopes: orgs / projects / environments ----

  app.post('/orgs', { preHandler: requirePermission('org.manage') }, async (req, reply) => {
    const parsed = orgCreateInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    try {
      const inserted = await deps.pool.query<{ id: string; name: string; slug: string; created_at: Date }>(
        'INSERT INTO api_orgs (name, slug) VALUES ($1, $2) RETURNING id::text, name, slug, created_at',
        [parsed.data.name, parsed.data.slug]
      );
      const r = inserted.rows[0]!;
      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'org.create',
        result: 'allow',
        orgId: r.id,
        resource: `org:${r.id}`,
        requestId: req.id,
      });
      const dto: OrgDto = {
        id: r.id,
        name: r.name,
        slug: r.slug,
        createdAt: r.created_at.toISOString(),
      };
      return reply.status(201).send(ok(dto));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError('CONFLICT', 'org slug already exists');
      }
      throw err;
    }
  });

  app.post('/projects', { preHandler: requirePermission('project.manage') }, async (req, reply) => {
    const parsed = projectCreateInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const { orgId, name, slug } = parsed.data;
    await assertScope(req, { orgId }, 'project.create', 'project.manage');
    try {
      const dto = await withTx(deps.pool, async (tx) => {
        const inserted = await tx.query<{ id: string; created_at: Date }>(
          'INSERT INTO api_projects (org_id, name, slug) VALUES ($1, $2, $3) RETURNING id::text, created_at',
          [orgId, name, slug]
        );
        const r = inserted.rows[0]!;
        const d: ProjectDto = {
          id: r.id,
          orgId,
          name,
          slug,
          createdAt: r.created_at.toISOString(),
        };
        await recordAudit(tx, {
          actorId: req.actor!.user.id,
          action: 'project.create',
          result: 'allow',
          orgId,
          projectId: d.id,
          resource: `project:${d.id}`,
          requestId: req.id,
        });
        return d;
      });
      return reply.status(201).send(ok(dto));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ApiError('CONFLICT', 'project slug already exists in this org');
      }
      throw err;
    }
  });

  app.post('/environments', { preHandler: requirePermission('project.manage') }, async (req, reply) => {
    const parsed = environmentCreateInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }
    const { projectId, name } = parsed.data;
    const parent = await deps.pool.query<{ id: string; org_id: string }>(
      'SELECT id::text, org_id::text FROM api_projects WHERE id = $1',
      [projectId]
    );
    const proj = parent.rows[0];
    if (!proj) throw new ApiError('NOT_FOUND', `project ${projectId} not found`);
    await assertScope(req, { orgId: proj.org_id, projectId }, 'environment.create', 'project.manage');

    const dto = await withTx(deps.pool, async (tx) => {
      const inserted = await tx.query<{ id: string; created_at: Date }>(
        'INSERT INTO api_environments (project_id, name) VALUES ($1, $2) RETURNING id::text, created_at',
        [projectId, name]
      );
      const r = inserted.rows[0]!;
      const d: EnvironmentDto = { id: r.id, projectId, name, createdAt: r.created_at.toISOString() };
      await recordAudit(tx, {
        actorId: req.actor!.user.id,
        action: 'env.create',
        result: 'allow',
        orgId: proj.org_id,
        projectId,
        environmentId: d.id,
        resource: `environment:${d.id}`,
        requestId: req.id,
      });
      return d;
    });
    return reply.status(201).send(ok(dto));
  });

  // ---- audit trail ----

  app.get('/audit-events', { preHandler: requirePermission('audit.read') }, async (req) => {
    const parsed = auditListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid query', parsed.error.flatten());
    }
    const limit = parsed.data.limit ?? 50;
    const { where, params } = buildAuditWhere(
      {
        actorId: parsed.data.actorId,
        action: parsed.data.action,
        result: parsed.data.result,
        orgId: parsed.data.orgId,
        projectId: parsed.data.projectId,
        environmentId: parsed.data.environmentId,
        from: parsed.data.from,
        to: parsed.data.to,
      },
      decodeCursor(parsed.data.cursor)
    );
    const rows = await deps.pool.query<{
      id: string;
      actor_id: string | null;
      action: string;
      result: AuditEventDto['result'];
      org_id: string | null;
      project_id: string | null;
      environment_id: string | null;
      resource: string | null;
      request_id: string | null;
      details: unknown;
      created_at: Date;
    }>(
      `SELECT id::text, actor_id::text, action, result, org_id::text, project_id::text,
              environment_id::text, resource, request_id, details, created_at
       FROM api_audit_events
       WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`,
      [...params, limit + 1]
    );
    const items: AuditEventDto[] = rows.rows.slice(0, limit).map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      result: r.result,
      orgId: r.org_id,
      projectId: r.project_id,
      environmentId: r.environment_id,
      resource: r.resource,
      requestId: r.request_id,
      details: r.details,
      createdAt: r.created_at.toISOString(),
    }));
    let nextCursor: string | null = null;
    if (rows.rows.length > limit) {
      const last = rows.rows[limit - 1]!;
      nextCursor = Buffer.from(`${last.created_at.getTime()}|${last.id}`).toString('base64url');
    }
    return ok({ items, nextCursor } satisfies Page<AuditEventDto>);
  });
  console.log('[boot] plugin:admin exit');
}

const bindingCols =
  'id::text, user_id::text, role, org_id::text, project_id::text, environment_id::text, created_at';
