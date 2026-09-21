/**
 * S2-D1 PG integration tests — real compose stack (PG + PgBouncer + pg-boss + API).
 * Orchestrated by scripts/integration.mjs (compose up → boot API → vitest → down, NO -v wipe).
 * Covers: auth happy paths, RBAC denials, audit-event filters/pagination,
 * session revocation on deactivate + password change.
 *
 * State model: fixture truncates api_* tables over the DIRECT :5433 connection
 * (data-level reset; docker volumes untouched), then drives one deterministic
 * scenario through the public HTTP API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type {
  GitConnectionDto,
  PolicyAssignmentDto,
  RepoLinkDto,
  StackDetectionDto,
} from '../../packages/shared/src/index.js';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3100';
const DB_URL = process.env.INTEGRATION_DB_URL;
if (!DB_URL) throw new Error('INTEGRATION_DB_URL (direct postgres://…:5433/…) is required');

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; requestId?: string };
}

async function call(
  path: string,
  init?: RequestInit & { token?: string }
): Promise<{ status: number; body: Envelope<unknown> }> {
  const headers: Record<string, string> = {};
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  if (init?.body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as Envelope<unknown> };
}

const ADMIN = {
  email: 'root@it.test',
  password: 'bootstrap-pass-123',
  newPassword: 'rotated-pass-456',
  displayName: 'Root Admin',
  orgName: 'Integration Org',
  orgSlug: 'integration-org',
};
const VIEWER = { email: 'viewer@it.test', password: 'viewer-pass-123456', displayName: 'View Er' };

let adminToken: string; // session A (survives password change)
let adminTokenB: string; // session B (killed by password change)
let viewerToken: string;
let adminId: string;
let viewerId: string;
let orgId: string;

beforeAll(async () => {
  // Data-level fixture reset over the direct port; CASCADE resolves FK order.
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query(
    `TRUNCATE api_sessions, api_role_bindings, api_audit_events,
            api_git_connections, api_webhook_events, api_repo_links,
            api_git_branches, api_git_commits, api_git_pull_requests,
            api_stack_detections, api_policy_assignments,
            api_environments, api_projects, api_orgs, api_users RESTART IDENTITY CASCADE`
  );
  await c.end();
});

afterAll(async () => {
  // Leave the floor as found: nothing running from the test itself.
});

describe('S2 auth/RBAC/audit against real PG', () => {
  it('bootstrap-once: first user+org with manager+security_admin', async () => {
    const r = await call('/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify(ADMIN),
    });
    expect(r.status).toBe(201);
    adminToken = (r.body.data as { token: string }).token;
    expect(adminToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    // SessionDto carries only token+expiresAt — identity comes from /auth/me.
    const me = await call('/auth/me', { token: adminToken });
    expect(me.status).toBe(200);
    const m = me.body.data as {
      user: { id: string };
      bindings: { orgId: string; role: string }[];
    };
    adminId = m.user.id;
    orgId = m.bindings[0]!.orgId;
    expect(m.bindings.map((b) => b.role).sort()).toEqual(['manager', 'security_admin']);
  });

  it('bootstrap replay → 409 CONFLICT (users exist)', async () => {
    const r = await call('/auth/bootstrap', { method: 'POST', body: JSON.stringify(ADMIN) });
    expect(r.status).toBe(409);
    expect(r.body.error!.code).toBe('CONFLICT');
  });

  it('second admin session + wrong-password denial', async () => {
    const good = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    expect(good.status).toBe(200);
    adminTokenB = (good.body.data as { token: string }).token;
    expect(adminTokenB).not.toBe(adminToken);

    const bad = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN.email, password: 'wrong-password' }),
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error!.code).toBe('UNAUTHORIZED');
  });

  it('admin step-up: fresh re-auth unlocks the admin plane', async () => {
    const r = await call('/auth/step-up', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ password: ADMIN.password }),
    });
    expect(r.status).toBe(200);
    expect((r.body.data as { stepUpGranted: boolean }).stepUpGranted).toBe(true);
  });

  it('user.manage: create role-less user; they can log in', async () => {
    const r = await call('/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify(VIEWER),
    });
    expect(r.status).toBe(201);
    viewerId = (r.body.data as { id: string }).id;
    expect(viewerId).not.toBe(adminId);

    const login = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: VIEWER.email, password: VIEWER.password }),
    });
    expect(login.status).toBe(200);
    viewerToken = (login.body.data as { token: string }).token;
  });

  it('RBAC denials: role-less user blocked from business/admin surfaces (audited)', async () => {
    const ex = await call('/examples', {
      method: 'POST',
      token: viewerToken,
      body: JSON.stringify({ name: 'should-fail' }),
    });
    expect(ex.status).toBe(403);
    expect(ex.body.error!.code).toBe('FORBIDDEN');

    const audit = await call('/audit-events', { token: viewerToken });
    expect(audit.status).toBe(403);
    expect(audit.body.error!.code).toBe('FORBIDDEN');

    const patch = await call(`/users/${viewerId}`, {
      method: 'PATCH',
      token: viewerToken,
      body: JSON.stringify({ isActive: true }),
    });
    expect(patch.status).toBe(403);
  });

  it('no-self rule: granting a role to yourself → 403, and the denial is audited (S2VAL-3a)', async () => {
    const r = await call('/role-bindings', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ userId: adminId, role: 'team_lead', orgId }),
    });
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe('FORBIDDEN');

    const audit = await call(
      `/audit-events?action=authz.deny.role.grant&actorId=${adminId}&result=deny&limit=10`,
      { token: adminToken }
    );
    expect(audit.status).toBe(200);
    const items = (audit.body.data as { items: { requestId: string | null }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.requestId)).toBe(true);
  });

  it('no-self rule: updating your own user → 403, and the denial is audited (S2VAL-3b)', async () => {
    const r = await call(`/users/${adminId}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({ isActive: false }),
    });
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe('FORBIDDEN');

    const audit = await call(
      `/audit-events?action=authz.deny.user.update&actorId=${adminId}&result=deny&limit=10`,
      { token: adminToken }
    );
    expect(audit.status).toBe(200);
    const items = (audit.body.data as { items: { details: { selfTarget?: string } | null }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.details?.selfTarget === adminId)).toBe(true);
  });

  it('grant developer to viewer → example.read allowed, example.create still denied', async () => {
    const grant = await call('/role-bindings', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ userId: viewerId, role: 'developer', orgId }),
    });
    expect(grant.status).toBe(201);

    const seed = await call('/examples', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ name: 'it-seed' }),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(seed.status).toBe(201);
    const id = (seed.body.data as { id: string }).id;

    const read = await call(`/examples/${id}`, { token: viewerToken });
    expect(read.status).toBe(200);

    const write = await call('/examples', {
      method: 'POST',
      token: viewerToken,
      body: JSON.stringify({ name: 'still-denied' }),
    });
    expect(write.status).toBe(403);
  });

  it('audit-event filters: result/actor/action each constrain the feed', async () => {
    const denies = await call('/audit-events?result=deny&limit=100', { token: adminToken });
    expect(denies.status).toBe(200);
    const denyItems = (denies.body.data as { items: { result: string; action: string }[] }).items;
    expect(denyItems.length).toBeGreaterThan(0);
    expect(denyItems.every((i) => i.result === 'deny')).toBe(true);
    expect(denyItems.some((i) => i.action === 'auth.login')).toBe(true);

    const byActor = await call(`/audit-events?actorId=${viewerId}&limit=100`, {
      token: adminToken,
    });
    const actorItems = (byActor.body.data as { items: { actorId: string | null }[] }).items;
    expect(actorItems.length).toBeGreaterThan(0);
    expect(actorItems.every((i) => i.actorId === viewerId)).toBe(true);

    const logins = await call('/audit-events?action=auth.login&result=allow&limit=100', {
      token: adminToken,
    });
    const loginItems = (logins.body.data as { items: { action: string; result: string }[] }).items;
    expect(loginItems.length).toBeGreaterThanOrEqual(2); // admin + viewer logins
    expect(loginItems.every((i) => i.action === 'auth.login' && i.result === 'allow')).toBe(true);
  });

  it('audit-event cursor pagination: strict (created_at,id) descent, disjoint pages', async () => {
    const p1 = await call('/audit-events?limit=2', { token: adminToken });
    const page1 = p1.body.data as { items: { id: string; createdAt: string }[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const p2 = await call(`/audit-events?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
      token: adminToken,
    });
    const page2 = p2.body.data as { items: { id: string; createdAt: string }[] };
    const ids1 = new Set(page1.items.map((i) => i.id));
    expect(page2.items.every((i) => !ids1.has(i.id))).toBe(true);
    expect(page1.items[1]!.createdAt >= page2.items[0]!.createdAt).toBe(true);
  });

  it('deactivate revokes live sessions immediately; inactive cannot re-login', async () => {
    const patch = await call(`/users/${viewerId}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({ isActive: false }),
    });
    expect(patch.status).toBe(200);
    expect((patch.body.data as { isActive: boolean }).isActive).toBe(false);

    const me = await call('/auth/me', { token: viewerToken });
    expect(me.status).toBe(401);

    const relogin = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: VIEWER.email, password: VIEWER.password }),
    });
    expect(relogin.status).toBe(401);
    expect(relogin.body.error!.message).toBe('invalid email or password'); // no account-existence leak
  });

  it('password change keeps current session, kills others, invalidates old password', async () => {
    const change = await call('/auth/change-password', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ currentPassword: ADMIN.password, newPassword: ADMIN.newPassword }),
    });
    expect(change.status).toBe(200);

    const otherSession = await call('/auth/me', { token: adminTokenB });
    expect(otherSession.status).toBe(401); // sibling session revoked

    const stillMe = await call('/auth/me', { token: adminToken });
    expect(stillMe.status).toBe(200); // current session survives

    const oldPw = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    expect(oldPw.status).toBe(401);

    const newPw = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.newPassword }),
    });
    expect(newPw.status).toBe(200);
    adminToken = (newPw.body.data as { token: string }).token;
  });

  it('logout revokes the calling session', async () => {
    const out = await call('/auth/logout', { method: 'POST', token: adminToken });
    expect(out.status).toBe(200);
    const me = await call('/auth/me', { token: adminToken });
    expect(me.status).toBe(401);
  });
});

describe('S3-D1 git plane against real PG', () => {
  const GIT_VIEWER = {
    email: 'gitviewer@it.test',
    password: 'gitviewer-pass-1234',
    displayName: 'Git Viewer',
  };
  let adminToken2: string;
  let viewer2Token: string;
  let connectionId: string;
  const projectId = (): string => projectIdCache;
  let projectIdCache: string;

  it('admin login; org-scoped connection create + list; unauth read denied', async () => {
    const login = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.newPassword }),
    });
    expect(login.status).toBe(200);
    adminToken2 = (login.body.data as { token: string }).token;

    const create = await call('/git-connections', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({ orgId, provider: 'github', displayName: 'IT Hub' }),
    });
    expect(create.status).toBe(201);
    const dto = create.body.data as GitConnectionDto;
    connectionId = dto.id;
    expect(dto.status).toBe('active');
    expect(dto.provider).toBe('github');

    const list = await call(`/git-connections?orgId=${orgId}`, { token: adminToken2 });
    expect(list.status).toBe(200);
    expect((list.body.data as { items: GitConnectionDto[] }).items.some((i) => i.id === connectionId)).toBe(
      true
    );

    const unauth = await call(`/git-connections?orgId=${orgId}`);
    expect(unauth.status).toBe(401);
  });

  it('developer reads git plane but cannot manage it (default-deny writes)', async () => {
    // Admin-plane calls need the S2-D2 step-up gate first.
    const su = await call('/auth/step-up', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({ password: ADMIN.newPassword }),
    });
    expect(su.status).toBe(200);

    const u = await call('/users', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify(GIT_VIEWER),
    });
    expect(u.status).toBe(201);
    const viewer2Id = (u.body.data as { id: string }).id;
    const grant = await call('/role-bindings', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({ userId: viewer2Id, role: 'developer', orgId }),
    });
    expect(grant.status).toBe(201);
    const vlogin = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: GIT_VIEWER.email, password: GIT_VIEWER.password }),
    });
    expect(vlogin.status).toBe(200);
    viewer2Token = (vlogin.body.data as { token: string }).token;

    const read = await call(`/git-connections?orgId=${orgId}`, { token: viewer2Token });
    expect(read.status).toBe(200); // developer holds git.read

    const write = await call('/git-connections', {
      method: 'POST',
      token: viewer2Token,
      body: JSON.stringify({ orgId, provider: 'gitlab' }),
    });
    expect(write.status).toBe(403);
    expect(write.body.error!.code).toBe('FORBIDDEN');
  });

  it('repo links: link project to connection, duplicate → 409, foreign connection → 404', async () => {
    // Seed a project via direct fixture connection (project onboarding UI/API is S3-D5).
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    const seeded = await c.query<{ id: string }>(
      "INSERT INTO api_projects (org_id, name, slug) VALUES ($1, 'Git IT', 'git-it') RETURNING id::text AS id",
      [orgId]
    );
    projectIdCache = seeded.rows[0]!.id;
    await c.end();

    const link = await call('/repo-links', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({
        projectId: projectId(),
        connectionId,
        externalRepoId: '42',
        fullName: 'acme/widgets',
      }),
    });
    expect(link.status).toBe(201);
    const ldto = link.body.data as RepoLinkDto;
    expect(ldto.provider).toBe('github');
    expect(ldto.fullName).toBe('acme/widgets');

    const dup = await call('/repo-links', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({
        projectId: projectId(),
        connectionId,
        externalRepoId: '42',
        fullName: 'acme/widgets',
      }),
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error!.code).toBe('CONFLICT');

    const foreign = await call('/repo-links', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({
        projectId: projectId(),
        connectionId: '00000000-0000-4000-8000-000000000000',
        externalRepoId: '43',
        fullName: 'acme/gadgets',
      }),
    });
    expect(foreign.status).toBe(404);
  });

  it('stack detections: record detector output verbatim; unknown stack kind → 422', async () => {
    const rec = await call('/stack-detections', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({
        projectId: projectId(),
        stacks: ['nextjs'],
        headless: false,
        evidence: { pkg: 'next' },
        detectorVersion: 'it-1',
      }),
    });
    expect(rec.status).toBe(201);
    expect((rec.body.data as StackDetectionDto).stacks).toEqual(['nextjs']);

    const bad = await call('/stack-detections', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({
        projectId: projectId(),
        stacks: ['angular'],
        headless: false,
        detectorVersion: 'it-1',
      }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error!.code).toBe('VALIDATION_ERROR');

    const list = await call(`/stack-detections?projectId=${projectId()}`, { token: adminToken2 });
    expect(list.status).toBe(200);
    expect((list.body.data as StackDetectionDto[]).some((s) => s.stacks.includes('nextjs'))).toBe(true);
  });

  it('policy assignments: org-level then same policy → 409; project-level allowed', async () => {
    const a1 = await call('/policy-assignments', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({ policyId: 'owasp-top10', orgId }),
    });
    expect(a1.status).toBe(201);
    expect((a1.body.data as PolicyAssignmentDto).enabled).toBe(true);

    const dup = await call('/policy-assignments', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({ policyId: 'owasp-top10', orgId }),
    });
    expect(dup.status).toBe(409);

    const projLevel = await call('/policy-assignments', {
      method: 'POST',
      token: adminToken2,
      body: JSON.stringify({ policyId: 'deps-audit', orgId, projectId: projectId() }),
    });
    expect(projLevel.status).toBe(201);

    const list = await call(`/policy-assignments?orgId=${orgId}`, { token: viewer2Token });
    expect(list.status).toBe(200); // developer git.read
    expect((list.body.data as PolicyAssignmentDto[]).length).toBeGreaterThanOrEqual(2);
  });

  it('revoke connection soft-deletes status; audit trail records the lifecycle', async () => {
    const del = await call(`/git-connections/${connectionId}`, {
      method: 'DELETE',
      token: adminToken2,
    });
    expect(del.status).toBe(200);
    expect((del.body.data as GitConnectionDto).status).toBe('revoked');

    const audit = await call('/audit-events?action=git.connection.revoke&result=allow&limit=10', {
      token: adminToken2,
    });
    expect(audit.status).toBe(200);
    expect(
      (audit.body.data as { items: { action: string }[] }).items.some((i) => i.action === 'git.connection.revoke')
    ).toBe(true);
  });
});
