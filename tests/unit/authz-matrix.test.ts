/**
 * S2-D6 — authorization-matrix unit tier.
 * The expectation table below is HAND-WRITTEN, deliberately independent of
 * ROLE_PERMISSIONS: any accidental matrix drift fails here instead of the
 * test re-deriving itself into a tautology. Sweeps every declared role x
 * every declared permission through the real resolver (can()), plus
 * fail-closed probes for unknown permissions and empty binding sets.
 */
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  can,
  permissionsOfRole,
  type Role,
  type RoleBindingView,
} from '../../packages/shared/src/index.js';

const EXPECTED_ALLOW: Record<Role, readonly string[]> = {
  manager: ['audit.read', 'audit.deep', 'staging.manage', 'example.create', 'example.read', 'git.manage', 'git.read', 'org.manage', 'project.manage', 'scheduler.manage', 'scheduler.read', 'finding.read', 'finding.update', 'scan.ingest', 'prod.execute', 'jit.request', 'jit.approve', 'jit.revoke', 'telegram.manage', 'secret.read.scoped'],
  team_lead: ['staging.manage', 'example.create', 'example.read', 'git.manage', 'git.read', 'project.manage', 'role.assign', 'finding.read', 'finding.update', 'scan.ingest', 'jit.request', 'jit.approve'],
  project_coordinator: ['example.create', 'example.read', 'git.read', 'finding.read'],
  developer: ['example.read', 'git.read', 'finding.read', 'jit.request'],
  security_admin: ['audit.read', 'audit.deep', 'role.assign', 'scheduler.manage', 'scheduler.read', 'user.manage', 'finding.read', 'finding.update', 'scan.ingest', 'prod.execute', 'jit.approve', 'jit.revoke', 'telegram.manage', 'secret.read.scoped'],
};

const ORG = 'o1';
const binding = (role: Role): RoleBindingView => ({
  role,
  orgId: ORG,
  projectId: null,
  environmentId: null,
});

describe('authorization matrix: role -> permission (S2-D6)', () => {
  it('covers every declared role with an exact hand-checked allow set', () => {
    expect([...ROLES].sort()).toEqual(Object.keys(EXPECTED_ALLOW).sort());
    for (const role of ROLES) {
      expect([...permissionsOfRole(role)].sort()).toEqual([...EXPECTED_ALLOW[role]].sort());
    }
  });

  it('full sweep: each declared permission resolves allowed iff expected', () => {
    for (const role of ROLES) {
      const bindings = [binding(role)];
      for (const perm of PERMISSIONS) {
        expect(can(bindings, { orgId: ORG }, perm)).toBe(
          EXPECTED_ALLOW[role].includes(perm),
          `${role} x ${perm}`
        );
      }
    }
  });

  it('fails closed: unmatched permission names and empty bindings deny everything', () => {
    const bindings = [binding('manager')];
    expect(can(bindings, { orgId: ORG }, 'no.such.permission' as never)).toBe(false);
    expect(can(bindings, {}, 'example.read')).toBe(false);
    for (const perm of PERMISSIONS) {
      expect(can([], { orgId: ORG }, perm)).toBe(false);
    }
  });
});
