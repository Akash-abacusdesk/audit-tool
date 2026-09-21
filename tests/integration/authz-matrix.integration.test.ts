/**
 * S2-D6 — authorization-matrix integration tier against the real compose
 * stack (PG + PgBouncer + API on :3100). For every role: one ALLOWED and one
 * DENIED route call, then audit-trail assertions (actor / scope / requestId /
 * result) via GET /audit-events, matching each response's echoed
 * x-request-id header to its recorded event.
 *
 * Privileged routes audit BOTH outcomes; ordinary /example* routes only audit
 * denials (requirePermission preHandler), never allows — asserted explicitly.
 *
 * Orchestrated by scripts/integration.mjs: compose up -> boot API -> vitest
 * tests/integration -> compose down WITHOUT -v. Fixture truncates api_* tables
 * over the DIRECT :5433 connection (data-level reset; volumes untouched).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3100';
const DB_URL = process.env.INTEGRATION_DB_URL;
if (!DB_URL) throw new Error('INTEGRATION_DB_URL (direct postgres://…:5433/…) is required');

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; requestId?: string };
}

interface AuditItem {
  id: string;
  actorId: string | null;
  action: string;
  result: string;
  orgId: string | null;
  projectId: string | null;
  resource: string | null;
  requestId: string | null;
  details: unknown;
}

async function call(
  path: string,
  init?: { method?: string; token?: string; body?: unknown }
): Promise<{ status: number; body: Envelope<unknown>; requestId: string | null }> {
  const headers: Record<string, string> = {};
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Envelope<unknown>,
    requestId: res.headers.get('x-request-id'),
  };
}

const RUN = crypto.randomUUID().slice(0, 8);

const ROOT = {
  email: `root-${RUN}@matrix.test`,
  password: 'bootstrap-pass-123',
  displayName: 'Root Admin',
  orgName: 'Matrix Org',
  orgSlug: `matrix-root-${RUN}`,
};

/** One fixture user per declared role; every row gets exactly one allow + one deny probe. */
const ROLE_USERS = [
  { role: 'manager', email: `mgr-${RUN}@matrix.test`, password: 'mgr-pass-12345678', displayName: 'Mx Manager' },
  { role: 'team_lead', email: `tl-${RUN}@matrix.test`, password: 'tl-pass-123456789', displayName: 'Tl Lead' },
  { role: 'project_coordinator', email: `pc-${RUN}@matrix.test`, password: 'pc-pass-1234567890', displayName: 'Pc Coord' },
  { role: 'developer', email: `dev-${RUN}@matrix.test`, password: 'dev-pass-12345678901', displayName: 'Dev Elloper' },
  { role: 'security_admin', email: `sec-${RUN}@matrix.test`, password: 'sec-pass-123456789012', displayName: 'Sec Admin' },
];

let adminToken: string;
let adminId: string;
let orgId: string;
let exampleId: string;
const SEED_EXAMPLE_NAME = 'matrix-seed-example';
const U = new Map<string, { id: string; token: string }>();

beforeAll(async () => {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query(
    `TRUNCATE api_sessions, api_role_bindings, api_audit_events,
            api_environments, api_projects, api_orgs, api_users RESTART IDENTITY CASCADE`
  );
  await c.end();
});

/** Fetch the single event matching actor+action+result+requestId (x-request-id echo). */
async function auditHit(q: {
  token: string;
  action: string;
  result: string;
  actorId: string;
  requestId: string | null;
}): Promise<AuditItem> {
  const r = await call(
    `/audit-events?action=${q.action}&result=${q.result}&actorId=${q.actorId}&limit=100`,
    { token: q.token }
  );
  expect(r.status).toBe(200);
  const items = (r.body.data as { items: AuditItem[] }).items;
  const hit = items.find((i) => i.requestId === q.requestId);
  expect(hit, `no ${q.result} ${q.action} audit event for request ${q.requestId}`).toBeTruthy();
  return hit!;
}

/** Coarse-gate deny: canonical 403 + audited authz.deny.<perm> with the echo id. */
async function expectDeny(
  r: Awaited<ReturnType<typeof call>>,
  opts: { token: string; actorId: string; perm: string; resource: string }
): Promise<void> {
  expect(r.status).toBe(403);
  expect(r.body.error?.code).toBe('FORBIDDEN');
  expect(r.body.error?.message).toBe(`missing permission: ${opts.perm}`);
  const hit = await auditHit({
    token: opts.token,
    action: `authz.deny.${opts.perm}`,
    result: 'deny',
    actorId: opts.actorId,
    requestId: r.requestId,
  });
  expect(hit.resource).toBe(opts.resource);
  expect((hit.details as { permission?: string }).permission).toBe(opts.perm);
}

describe('S2-D6 authorization matrix against real PG', () => {
  it('bootstrap root admin (manager+security_admin), step-up, seed example', async () => {
    const boot = await call('/auth/bootstrap', { method: 'POST', body: ROOT });
    expect(boot.status).toBe(201);
    adminToken = (boot.body.data as { token: string }).token;

    const me = await call('/auth/me', { token: adminToken });
    expect(me.status).toBe(200);
    const m = me.body.data as { user: { id: string }; bindings: { orgId: string; role: string }[] };
    adminId = m.user.id;
    orgId = m.bindings[0]!.orgId;
    expect(m.bindings.map((b) => b.role).sort()).toEqual(['manager', 'security_admin']);

    const up = await call('/auth/step-up', {
      method: 'POST',
      token: adminToken,
      body: { password: ROOT.password },
    });
    expect(up.status).toBe(200);

    const seed = await call('/examples', {
      method: 'POST',
      token: adminToken,
      body: { name: SEED_EXAMPLE_NAME },
    });
    expect(seed.status).toBe(201);
    exampleId = (seed.body.data as { id: string }).id;
  });

  // ~20 sequential HTTP roundtrips (5 roles x create/bind/login/step-up +
  // audit asserts) — needs headroom beyond vitest's 5s default under load.
  it('seed: create + bind + login + step-up all five roles (audited grants)', { timeout: 30_000 }, async () => {
    for (const u of ROLE_USERS) {
      const created = await call('/users', {
        method: 'POST',
        token: adminToken,
        body: { email: u.email, password: u.password, displayName: u.displayName },
      });
      expect(created.status).toBe(201);
      const id = (created.body.data as { id: string }).id;

      // privileged write leaves the expected audit event (actor + requestId echo)
      await auditHit({
        token: adminToken,
        action: 'user.create',
        result: 'allow',
        actorId: adminId,
        requestId: created.requestId,
      });

      const grant = await call('/role-bindings', {
        method: 'POST',
        token: adminToken,
        body: { userId: id, role: u.role, orgId },
      });
      expect(grant.status).toBe(201);
      const grantHit = await auditHit({
        token: adminToken,
        action: 'role.grant',
        result: 'allow',
        actorId: adminId,
        requestId: grant.requestId,
      });
      // scope assertion: the grant event carries the org it was granted in
      expect(grantHit.orgId).toBe(orgId);

      const login = await call('/auth/login', {
        method: 'POST',
        body: { email: u.email, password: u.password },
      });
      expect(login.status).toBe(200);
      const token = (login.body.data as { token: string }).token;

      const up = await call('/auth/step-up', {
        method: 'POST',
        token,
        body: { password: u.password },
      });
      expect(up.status).toBe(200);

      U.set(u.role, { id, token });
    }
    expect(U.size).toBe(ROLE_USERS.length);
  });

  it('manager: POST /orgs allowed (audited w/ scope), POST /users denied', async () => {
    const { id, token } = U.get('manager')!;

    const allow = await call('/orgs', {
      method: 'POST',
      token,
      body: { name: `Matrix Org ${RUN}`, slug: `matrix-org-${RUN}` },
    });
    expect(allow.status).toBe(201);
    const newOrgId = (allow.body.data as { id: string }).id;
    const hit = await auditHit({
      token: adminToken,
      action: 'org.create',
      result: 'allow',
      actorId: id,
      requestId: allow.requestId,
    });
    expect(hit.orgId).toBe(newOrgId);
    expect(hit.resource).toBe(`org:${newOrgId}`);

    await expectDeny(
      await call('/users', {
        method: 'POST',
        token,
        body: { email: `denied-${RUN}@matrix.test`, password: 'denied-pass-123456', displayName: 'Denied' },
      }),
      { token: adminToken, actorId: id, perm: 'user.manage', resource: 'POST /api/v1/users' }
    );
  });

  it('team_lead: POST /projects allowed (audited w/ scope), GET /audit-events denied', async () => {
    const { id, token } = U.get('team_lead')!;

    const allow = await call('/projects', {
      method: 'POST',
      token,
      body: { orgId, name: `Matrix Project ${RUN}`, slug: `matrix-proj-${RUN}` },
    });
    expect(allow.status).toBe(201);
    const projectId = (allow.body.data as { id: string }).id;
    const hit = await auditHit({
      token: adminToken,
      action: 'project.create',
      result: 'allow',
      actorId: id,
      requestId: allow.requestId,
    });
    expect(hit.orgId).toBe(orgId);
    expect(hit.projectId).toBe(projectId);

    await expectDeny(await call('/audit-events?limit=10', { token }), {
      token: adminToken,
      actorId: id,
      perm: 'audit.read',
      // resource records req.url verbatim — querystring included
      resource: 'GET /api/v1/audit-events?limit=10',
    });
  });

  it('project_coordinator: POST /examples allowed (no allow-audit on ordinary route), POST /projects denied', async () => {
    const { id, token } = U.get('project_coordinator')!;

    const allow = await call('/examples', { method: 'POST', token, body: { name: 'pc-created' } });
    expect(allow.status).toBe(201);

    // ordinary business route: allow outcomes are NOT audited — assert the absence
    const none = await call(`/audit-events?action=example.create&result=allow&actorId=${id}&limit=100`, {
      token: adminToken,
    });
    expect((none.body.data as { items: AuditItem[] }).items).toHaveLength(0);

    await expectDeny(
      await call('/projects', {
        method: 'POST',
        token,
        body: { orgId, name: 'denied-project', slug: `denied-proj-${RUN}` },
      }),
      { token: adminToken, actorId: id, perm: 'project.manage', resource: 'POST /api/v1/projects' }
    );
  });

  it('developer: GET /examples/:id allowed, POST /examples denied', async () => {
    const { id, token } = U.get('developer')!;

    const allow = await call(`/examples/${exampleId}`, { token });
    expect(allow.status).toBe(200);
    expect((allow.body.data as { name: string }).name).toBe(SEED_EXAMPLE_NAME);

    await expectDeny(await call('/examples', { method: 'POST', token, body: { name: 'dev-denied' } }), {
      token: adminToken,
      actorId: id,
      perm: 'example.create',
      resource: 'POST /api/v1/examples',
    });
  });

  it('security_admin: GET /audit-events allowed, POST /examples denied (separation of duties)', async () => {
    const { id, token } = U.get('security_admin')!;

    const allow = await call('/audit-events?limit=10', { token });
    expect(allow.status).toBe(200);
    expect((allow.body.data as { items: AuditItem[] }).items.length).toBeGreaterThan(0);

    await expectDeny(await call('/examples', { method: 'POST', token, body: { name: 'sec-denied' } }), {
      token: adminToken,
      actorId: id,
      perm: 'example.create',
      resource: 'POST /api/v1/examples',
    });
  });
});
