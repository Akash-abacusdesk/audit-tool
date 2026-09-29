import { describe, expect, it } from 'vitest';
import {
  ROLES,
  assignableRolesFor,
  can,
  permissionsFor,
  permissionsOfRole,
  type RoleBindingView,
} from '../../packages/shared/src/index.js';
import { hashPassword, verifyPassword } from '../../apps/api/src/auth/passwords.js';

const ORG = 'o1';
const b = (over: Partial<RoleBindingView>): RoleBindingView => ({
  role: 'developer',
  orgId: ORG,
  projectId: null,
  environmentId: null,
  ...over,
});

describe('rbac resolver (default deny)', () => {
  it('denies everything with no bindings', () => {
    expect(permissionsFor([], { orgId: ORG }).size).toBe(0);
    expect(can([], { orgId: ORG }, 'example.read')).toBe(false);
  });

  it('org-wide binding grants at org, project and environment level', () => {
    const bindings = [b({ role: 'manager' })];
    expect(can(bindings, { orgId: ORG }, 'org.manage')).toBe(true);
    expect(can(bindings, { orgId: ORG, projectId: 'p1' }, 'project.manage')).toBe(true);
    expect(can(bindings, { orgId: ORG, projectId: 'p1', environmentId: 'e1' }, 'example.create')).toBe(true);
  });

  it('project binding does not apply to org-level ops or other projects', () => {
    const bindings = [b({ role: 'team_lead', projectId: 'p1' })];
    expect(can(bindings, { orgId: ORG }, 'role.assign')).toBe(false);
    expect(can(bindings, { orgId: ORG, projectId: 'p2' }, 'example.read')).toBe(false);
    expect(can(bindings, { orgId: ORG, projectId: 'p1' }, 'role.assign')).toBe(true);
    expect(can(bindings, { orgId: ORG, projectId: 'p1', environmentId: 'e1' }, 'role.assign')).toBe(true);
  });

  it('environment binding applies only to that environment', () => {
    const bindings = [b({ role: 'developer', projectId: 'p1', environmentId: 'e1' })];
    expect(can(bindings, { orgId: ORG, projectId: 'p1', environmentId: 'e1' }, 'example.read')).toBe(true);
    expect(can(bindings, { orgId: ORG, projectId: 'p1', environmentId: 'e2' }, 'example.read')).toBe(false);
    expect(can(bindings, { orgId: ORG, projectId: 'p1' }, 'example.read')).toBe(false);
  });

  it('bindings from another org never apply', () => {
    const bindings = [b({ role: 'manager', orgId: 'other' })];
    expect(can(bindings, { orgId: ORG }, 'org.manage')).toBe(false);
  });

  it('every defined role resolves its declared permissions and nothing else', () => {
    for (const role of ROLES) {
      const granted = permissionsOfRole(role);
      expect(granted.length).toBeGreaterThan(0);
      const bindings = [b({ role })];
      const resolved = permissionsFor(bindings, { orgId: ORG });
      for (const p of granted) expect(resolved.has(p)).toBe(true);
      // unmatched permission fails closed
      expect(can(bindings, { orgId: ORG }, 'user.manage')).toBe(role === 'security_admin');
    }
  });

  it('security_admin holds no business permissions (separation of duties)', () => {
    const perms = permissionsOfRole('security_admin');
    expect(perms).not.toContain('example.create');
    expect(perms).not.toContain('example.read');
    expect(perms).toContain('user.manage');
    expect(perms).toContain('audit.read');
  });

  it('git-plane permissions split manage vs read across roles (S3-D1)', () => {
    expect(permissionsOfRole('manager')).toContain('git.manage');
    expect(permissionsOfRole('team_lead')).toContain('git.manage');
    expect(permissionsOfRole('developer')).toContain('git.read');
    expect(permissionsOfRole('developer')).not.toContain('git.manage');
    expect(permissionsOfRole('project_coordinator')).toContain('git.read');
    expect(permissionsOfRole('security_admin')).not.toContain('git.manage');
    expect(permissionsOfRole('security_admin')).not.toContain('git.read');
    // project-scoped team_lead cannot exercise org-level connection ops
    const bindings = [b({ role: 'team_lead', projectId: 'p1' })];
    expect(can(bindings, { orgId: ORG }, 'git.manage')).toBe(false);
    expect(can(bindings, { orgId: ORG, projectId: 'p1' }, 'git.manage')).toBe(true);
  });

  it('role.assign has a privilege ceiling: team_lead cannot grant manager/security_admin', () => {
    const bindings = [b({ role: 'team_lead', projectId: 'p1' })];
    const assignable = assignableRolesFor(bindings, { orgId: ORG, projectId: 'p1' });
    expect(assignable.has('developer')).toBe(true);
    expect(assignable.has('project_coordinator')).toBe(true);
    expect(assignable.has('manager')).toBe(false);
    expect(assignable.has('security_admin')).toBe(false);
    expect(assignable.has('team_lead')).toBe(false);
    // no coverage at this scope -> nothing assignable
    expect(assignableRolesFor(bindings, { orgId: ORG, projectId: 'p2' }).size).toBe(0);
  });

  it('security_admin may grant any role', () => {
    const bindings = [b({ role: 'security_admin' })];
    const assignable = assignableRolesFor(bindings, { orgId: ORG });
    for (const role of ROLES) expect(assignable.has(role)).toBe(true);
  });
});

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
    expect(await verifyPassword('correct horse battery staple', 'garbage')).toBe(false);
  });
});
