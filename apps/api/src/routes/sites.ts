import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  ApiError,
  ok,
  isUuid,
  siteCreateInput,
  siteUpdateInput,
  teamMemberCreateInput,
  teamMemberUpdateInput,
  type SiteDto,
  type TaskDto,
  type TeamMemberDto,
} from '@platform/shared';
import { recordAudit, type Queryable } from '../auth/audit.js';
import { hashPassword } from '../auth/passwords.js';
import { assertScope, requirePermission } from '../auth/service.js';
import { orgsWith } from '../auth/scope.js';
import { withTx } from '../db/pool.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { adminChatIds, dispatchAlert, telegramBotId } from '../sites/alerts.js';
import { taskDelivery, taskPortalFromEnv } from '../tasks/portal.js';

interface Deps {
  pool: Pool;
  scheduler?: Scheduler;
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';

/** A user visible to this admin: has no bindings yet (freshly created), or is bound in an org they manage. */
const VISIBLE_USER = `(NOT EXISTS (SELECT 1 FROM api_role_bindings b WHERE b.user_id = u.id)
   OR EXISTS (SELECT 1 FROM api_role_bindings b WHERE b.user_id = u.id AND b.org_id = ANY($1::uuid[])))`;

const SITE_SELECT = `
  SELECT s.id::text, s.org_id::text, s.project_id::text, s.name, s.url, s.status, s.created_at,
         u.id::text AS owner_id, u.display_name AS owner_name, u.email AS owner_email, u.telegram_chat_id AS owner_chat,
         lr.scan_id AS last_scan_id, lr.tool_name AS last_tool, lr.status AS last_status, lr.created_at AS last_at,
         (SELECT count(*)::int FROM api_scan_findings f WHERE f.project_id = s.project_id AND f.status IN ('open', 'in_progress')) AS open_findings,
         (SELECT count(*)::int FROM task_outbox t WHERE t.site_id = s.id) AS tasks
    FROM api_sites s
    LEFT JOIN api_users u ON u.id = s.owner_user_id
    LEFT JOIN LATERAL (SELECT scan_id, tool_name, status, created_at FROM api_scan_runs r
                        WHERE r.project_id = s.project_id ORDER BY r.created_at DESC LIMIT 1) lr ON true`;

interface SiteRow {
  id: string; org_id: string; project_id: string; name: string; url: string | null; status: 'active' | 'paused'; created_at: Date;
  owner_id: string | null; owner_name: string | null; owner_email: string | null; owner_chat: string | null;
  last_scan_id: string | null; last_tool: string | null; last_status: string | null; last_at: Date | null;
  open_findings: number; tasks: number;
}

const toSite = (r: SiteRow): SiteDto => ({
  id: r.id,
  orgId: r.org_id,
  projectId: r.project_id,
  name: r.name,
  url: r.url,
  status: r.status,
  owner: r.owner_id ? { id: r.owner_id, displayName: r.owner_name ?? '', email: r.owner_email ?? '', telegramChatId: r.owner_chat } : null,
  lastScan: r.last_scan_id ? { scanId: r.last_scan_id, tool: r.last_tool ?? '', status: r.last_status ?? '', at: r.last_at!.toISOString() } : null,
  openFindings: r.open_findings,
  tasks: r.tasks,
  createdAt: r.created_at.toISOString(),
});

export async function siteRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:sites enter');

  async function loadSite(db: Queryable, id: string): Promise<SiteRow> {
    if (!isUuid(id)) throw new ApiError('VALIDATION_ERROR', 'site id must be a uuid');
    const r = await (db as Pool).query<SiteRow>(`${SITE_SELECT} WHERE s.id = $1`, [id]);
    if (!r.rows[0]) throw new ApiError('NOT_FOUND', `site ${id} not found`);
    return r.rows[0];
  }

  /** The owner must be a real, active user; they get `developer` on the site's project so they can see its findings. */
  async function assertOwner(db: Queryable, userId: string): Promise<void> {
    const r = await (db as Pool).query('SELECT 1 FROM api_users WHERE id = $1 AND is_active', [userId]);
    if (r.rowCount === 0) throw new ApiError('VALIDATION_ERROR', 'owner must be an active team member');
  }
  async function grantOwner(db: Queryable, actorId: string, userId: string, orgId: string, projectId: string): Promise<void> {
    await db.query(
      `INSERT INTO api_role_bindings (user_id, role, org_id, project_id, granted_by)
       VALUES ($1, 'developer', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [userId, orgId, projectId, actorId]
    );
  }
  async function revokeOwner(db: Queryable, userId: string, orgId: string, projectId: string): Promise<void> {
    await db.query(
      `DELETE FROM api_role_bindings WHERE user_id = $1 AND role = 'developer' AND org_id = $2 AND project_id = $3 AND environment_id IS NULL`,
      [userId, orgId, projectId]
    );
  }

  // ---------------------------------------------------------------- sites

  app.get('/sites', { preHandler: requirePermission('project.manage') }, async (req) => {
    const rows = await deps.pool.query<SiteRow>(`${SITE_SELECT} WHERE s.org_id = ANY($1::uuid[]) ORDER BY s.created_at DESC`, [orgsWith(req, 'project.manage')]);
    return ok(rows.rows.map(toSite));
  });

  app.post('/sites', { preHandler: requirePermission('project.manage') }, async (req, reply) => {
    const parsed = siteCreateInput.safeParse(req.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    const { orgId, name, url, ownerUserId } = parsed.data;
    await assertScope(req, { orgId }, 'site.create', 'project.manage');
    const actorId = req.actor!.user.id;

    const siteId = await withTx(deps.pool, async (tx) => {
      if (ownerUserId) await assertOwner(tx, ownerUserId);
      // The site's project slug must be unique in the org: pick the first free "name", "name-2", ...
      const base = slugify(name);
      const taken = new Set(
        (await tx.query<{ slug: string }>('SELECT slug FROM api_projects WHERE org_id = $1 AND slug LIKE $2', [orgId, `${base}%`])).rows.map((r) => r.slug)
      );
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

      const project = (await tx.query<{ id: string }>('INSERT INTO api_projects (org_id, name, slug) VALUES ($1, $2, $3) RETURNING id::text', [orgId, name, slug])).rows[0]!;
      await tx.query("INSERT INTO api_environments (project_id, name) VALUES ($1, 'production')", [project.id]);
      const id = (
        await tx.query<{ id: string }>(
          'INSERT INTO api_sites (org_id, project_id, name, url, owner_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id::text',
          [orgId, project.id, name, url ?? null, ownerUserId ?? null]
        )
      ).rows[0]!.id;
      if (ownerUserId) await grantOwner(tx, actorId, ownerUserId, orgId, project.id);
      await recordAudit(tx, { actorId, action: 'site.create', result: 'allow', orgId, projectId: project.id, resource: `site:${id}`, requestId: req.id, details: { name, ownerUserId: ownerUserId ?? null } });
      return id;
    });
    return reply.status(201).send(ok(toSite(await loadSite(deps.pool, siteId))));
  });

  app.patch('/sites/:id', { preHandler: requirePermission('project.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = siteUpdateInput.safeParse(req.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    const cur = await loadSite(deps.pool, id);
    await assertScope(req, { orgId: cur.org_id }, 'site.update', 'project.manage');
    const p = parsed.data;
    const actorId = req.actor!.user.id;

    await withTx(deps.pool, async (tx) => {
      if (p.ownerUserId) await assertOwner(tx, p.ownerUserId);
      await tx.query(
        `UPDATE api_sites SET name = COALESCE($2, name), url = CASE WHEN $3::boolean THEN $4 ELSE url END,
                owner_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE owner_user_id END,
                status = COALESCE($7, status), updated_at = now() WHERE id = $1`,
        [id, p.name ?? null, p.url !== undefined, p.url ?? null, p.ownerUserId !== undefined, p.ownerUserId ?? null, p.status ?? null]
      );
      if (p.name) await tx.query('UPDATE api_projects SET name = $2 WHERE id = $1', [cur.project_id, p.name]);
      if (p.ownerUserId !== undefined && p.ownerUserId !== cur.owner_id) {
        if (cur.owner_id) await revokeOwner(tx, cur.owner_id, cur.org_id, cur.project_id);
        if (p.ownerUserId) await grantOwner(tx, actorId, p.ownerUserId, cur.org_id, cur.project_id);
      }
      await recordAudit(tx, { actorId, action: 'site.update', result: 'allow', orgId: cur.org_id, projectId: cur.project_id, resource: `site:${id}`, requestId: req.id, details: p });
    });
    return ok(toSite(await loadSite(deps.pool, id)));
  });

  /** Sends a real Telegram message to the site's owner and the org admins, so chat ids can be checked before a real failure. */
  app.post('/sites/:id/test-alert', { preHandler: requirePermission('project.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const site = await loadSite(deps.pool, id);
    await assertScope(req, { orgId: site.org_id }, 'site.test-alert', 'project.manage');
    const chats = [...new Set([...(site.owner_chat ? [site.owner_chat] : []), ...(await adminChatIds(deps.pool, site.org_id))])];
    const body = `✅ Test alert for ${site.name}: scan-failure alerts will reach this chat.`;
    const ids: string[] = [];
    for (const chat of chats) {
      const r = await deps.pool.query<{ id: string }>(
        `INSERT INTO notification_outbox (event_type, bot_id, chat_id, body) VALUES ('site.test', $1, $2, $3) RETURNING id::text`,
        [telegramBotId(), chat, body]
      );
      ids.push(r.rows[0]!.id);
    }
    await dispatchAlert(deps.scheduler, { siteId: id, siteName: site.name, notificationIds: ids, taskId: null });
    return ok({ recipients: chats.length });
  });

  // ---------------------------------------------------------------- team members

  const toMember = (r: { id: string; email: string; display_name: string; is_active: boolean; telegram_chat_id: string | null; created_at: Date; roles: string[]; sites: { id: string; name: string }[] }): TeamMemberDto => ({
    id: r.id, email: r.email, displayName: r.display_name, isActive: r.is_active, telegramChatId: r.telegram_chat_id,
    roles: r.roles, sites: r.sites, createdAt: r.created_at.toISOString(),
  });
  const MEMBER_SELECT = `
    SELECT u.id::text, u.email, u.display_name, u.is_active, u.telegram_chat_id, u.created_at,
           COALESCE((SELECT array_agg(DISTINCT b.role) FROM api_role_bindings b WHERE b.user_id = u.id AND b.project_id IS NULL AND b.environment_id IS NULL), '{}') AS roles,
           COALESCE((SELECT json_agg(json_build_object('id', s.id::text, 'name', s.name)) FROM api_sites s WHERE s.owner_user_id = u.id), '[]'::json) AS sites
      FROM api_users u`;

  app.get('/team-members', { preHandler: requirePermission('user.manage') }, async (req) => {
    const rows = await deps.pool.query(`${MEMBER_SELECT} WHERE ${VISIBLE_USER} ORDER BY u.created_at`, [orgsWith(req, 'user.manage')]);
    return ok(rows.rows.map(toMember));
  });

  app.post('/team-members', { preHandler: requirePermission('user.manage') }, async (req, reply) => {
    const parsed = teamMemberCreateInput.safeParse(req.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    const { email, displayName, password, telegramChatId } = parsed.data;
    const passwordHash = await hashPassword(password);
    try {
      const id = await withTx(deps.pool, async (tx) => {
        const r = await tx.query<{ id: string }>(
          'INSERT INTO api_users (email, display_name, password_hash, telegram_chat_id) VALUES ($1, $2, $3, $4) RETURNING id::text',
          [email.toLowerCase(), displayName, passwordHash, telegramChatId ?? null]
        );
        await recordAudit(tx, { actorId: req.actor!.user.id, action: 'team.create', result: 'allow', resource: `user:${r.rows[0]!.id}`, requestId: req.id });
        return r.rows[0]!.id;
      });
      const row = (await deps.pool.query(`${MEMBER_SELECT} WHERE u.id = $1`, [id])).rows[0];
      return reply.status(201).send(ok(toMember(row)));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ApiError('CONFLICT', 'a user with that email already exists');
      throw err;
    }
  });

  app.patch('/team-members/:id', { preHandler: requirePermission('user.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new ApiError('VALIDATION_ERROR', 'id must be a uuid');
    const parsed = teamMemberUpdateInput.safeParse(req.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    const p = parsed.data;
    // 404 (not 403) for a member outside the admin's orgs: don't reveal they exist.
    const visible = await deps.pool.query(`SELECT 1 FROM api_users u WHERE u.id = $2 AND ${VISIBLE_USER}`, [orgsWith(req, 'user.manage'), id]);
    if (visible.rowCount === 0) throw new ApiError('NOT_FOUND', `team member ${id} not found`);
    await withTx(deps.pool, async (tx) => {
      await tx.query(
        `UPDATE api_users SET display_name = COALESCE($2, display_name),
                telegram_chat_id = CASE WHEN $3::boolean THEN $4 ELSE telegram_chat_id END WHERE id = $1`,
        [id, p.displayName ?? null, p.telegramChatId !== undefined, p.telegramChatId ?? null]
      );
      await recordAudit(tx, { actorId: req.actor!.user.id, action: 'team.update', result: 'allow', resource: `user:${id}`, requestId: req.id, details: { fields: Object.keys(p) } });
    });
    return ok(toMember((await deps.pool.query(`${MEMBER_SELECT} WHERE u.id = $1`, [id])).rows[0]));
  });

  // ---------------------------------------------------------------- tasks (outbox to the task portal)

  app.get('/tasks', { preHandler: requirePermission('project.manage') }, async (req) => {
    const q = req.query as { siteId?: string; status?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 100) || 100));
    const rows = await deps.pool.query<{
      id: string; site_id: string | null; site_name: string | null; a_id: string | null; a_name: string | null; a_email: string | null;
      kind: string; title: string; description: string; status: TaskDto['status']; external_id: string | null; attempts: number;
      last_error: string | null; created_at: Date; sent_at: Date | null;
    }>(
      `SELECT t.id::text, t.site_id::text, s.name AS site_name, u.id::text AS a_id, u.display_name AS a_name, u.email AS a_email,
              t.kind, t.title, t.description, t.status, t.external_id, t.attempts, t.last_error, t.created_at, t.sent_at
         FROM task_outbox t JOIN api_sites s ON s.id = t.site_id LEFT JOIN api_users u ON u.id = t.assignee_user_id
        WHERE s.org_id = ANY($1::uuid[])
          AND ($2::uuid IS NULL OR t.site_id = $2::uuid) AND ($3::text IS NULL OR t.status = $3)
        ORDER BY t.created_at DESC LIMIT $4`,
      [orgsWith(req, 'project.manage'), q.siteId && isUuid(q.siteId) ? q.siteId : null, q.status ?? null, limit]
    );
    const items: TaskDto[] = rows.rows.map((r) => ({
      id: r.id, siteId: r.site_id, siteName: r.site_name,
      assignee: r.a_id ? { id: r.a_id, displayName: r.a_name ?? '', email: r.a_email ?? '' } : null,
      kind: r.kind, title: r.title, description: r.description, status: r.status, externalId: r.external_id,
      attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at.toISOString(), sentAt: r.sent_at?.toISOString() ?? null,
    }));
    return ok({ portalConfigured: taskPortalFromEnv() !== null, items });
  });

  app.post('/tasks/:id/retry', { preHandler: requirePermission('project.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new ApiError('VALIDATION_ERROR', 'id must be a uuid');
    const r = await deps.pool.query(
      `UPDATE task_outbox t SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = now()
         FROM api_sites s WHERE t.id = $1 AND s.id = t.site_id AND s.org_id = ANY($2::uuid[]) AND t.status <> 'sent'`,
      [id, orgsWith(req, 'project.manage')]
    );
    if (r.rowCount === 0) throw new ApiError('NOT_FOUND', 'task not found or already delivered');
    await taskDelivery.kick();
    return ok({ id, status: 'pending' });
  });

  console.log('[boot] plugin:sites exit');
}
