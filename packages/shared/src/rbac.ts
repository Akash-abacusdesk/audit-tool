/**
 * RBAC core: roles, permissions, scope model, default-deny resolver.
 * Shared by API (enforcement) and portal (UI gating) so both sides agree.
 *
 * Scope model — bindings are nested; a binding grants its role's permissions
 * within everything it contains (org ⊇ projects ⊇ environments):
 *   { orgId }                          → whole organization
 *   { orgId, projectId }               → all environments of one project
 *   { orgId, projectId, environmentId} → a single environment
 *
 * Default-deny: permissionsFor returns only explicitly granted permissions;
 * anything unmatched is denied by construction.
 */

export const ROLES = [
  'manager',
  'team_lead',
  'project_coordinator',
  'developer',
  'security_admin',
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.manage',
  'project.manage',
  'user.manage',
  'role.assign',
  'audit.read',
  // Section-14 deep security/posture audit (S14): enqueue/read the serialized
  // 7-stage pipeline. Never targets a live production environment.
  'audit.deep',
  // Section-11 safe staging (S11): provision/test-run/destroy an ephemeral
  // sanitized staging environment. The safety gate (§ staging.ts) is enforced
  // server-side regardless of this permission.
  'staging.manage',
  'example.create',
  'example.read',
  // Section-3 git plane (S3-D1): connections/repo links/stack detections/
  // policy assignments. manage = write ops, read = portal visibility.
  'git.manage',
  'git.read',
  // Section-5 scanning plane (S5-D1): normalized findings + scan runs.
  // read = portal visibility; update = lifecycle triage (status/assignment);
  // ingest = scanning pipeline writing results (machine/security context).
  'finding.read',
  'finding.update',
  'scan.ingest',
  // Section-4A scheduler plane: telemetry visibility + job ops (enqueue
  // demo/cancel). Global resource — coarse gate only, no scope re-check.
  'scheduler.read',
  'scheduler.manage',
  // Section-7 safe production control (S7-D1): invoke the restricted prod
  // command service. Always paired with an approval reference (see
  // apps/api/src/prod/control.ts); never grant to automated/CI identities
  // without a matching approval flow.
  'prod.execute',
  // Section-8 just-in-time privileged access (S8-D1): JIT grant lifecycle.
  // request/approve/revoke are human RBAC-gated; redeem uses the opaque token
  // (no session) so it has no user permission by design.
  'jit.request',
  'jit.approve',
  'jit.revoke',
  // Section-9 Telegram ops callback control plane (S9-D1): manage the
  // per-(chatId,userId) authorization allow-list. The callback webhook itself
  // is authenticated by its HMAC secret token, not a session permission.
  'telegram.manage',
  // Section-15 scoped secret retrieval. Workers never get direct Vaultwarden
  // access; trusted control-plane users may retrieve scoped injected values.
  'secret.read.scoped',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Starter matrix (Section-2 baseline, tighten per PRD reviews).
 * Separation of duties: security_admin holds only security administration
 * (no business permissions); user management lives with security_admin alone.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  manager: ['org.manage', 'project.manage', 'audit.read', 'audit.deep', 'staging.manage', 'example.create', 'example.read', 'git.manage', 'git.read',   'scheduler.read', 'scheduler.manage', 'finding.read', 'finding.update', 'scan.ingest', 'prod.execute', 'jit.request', 'jit.approve', 'jit.revoke', 'telegram.manage', 'secret.read.scoped'],
  team_lead: ['project.manage', 'role.assign', 'staging.manage', 'example.create', 'example.read', 'git.manage', 'git.read', 'finding.read', 'finding.update', 'scan.ingest', 'jit.request', 'jit.approve'],
  project_coordinator: ['example.create', 'example.read', 'git.read', 'finding.read'],
  developer: ['example.read', 'git.read', 'finding.read', 'jit.request'],
  security_admin: ['user.manage', 'role.assign', 'audit.read', 'audit.deep', 'scheduler.read', 'scheduler.manage',   'finding.read', 'finding.update', 'scan.ingest', 'prod.execute', 'jit.approve', 'jit.revoke', 'telegram.manage', 'secret.read.scoped'],
};

export function permissionsOfRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** A resolved binding as seen by the resolver (DB rows map 1:1). */
export interface RoleBindingView {
  role: Role;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
}

/** The scope an action targets. Omit projectId/environmentId for org-level ops. */
export interface ScopeRef {
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
}

function bindingCovers(b: RoleBindingView, t: ScopeRef): boolean {
  if (b.orgId !== t.orgId) return false;
  // A project/env-scoped binding never applies to an org-level operation.
  if (!t.projectId && b.projectId) return false;
  if (b.projectId && b.projectId !== t.projectId) return false;
  if (!t.environmentId && b.environmentId) return false;
  if (b.environmentId && b.environmentId !== t.environmentId) return false;
  return true;
}

/** All permissions the bindings grant at the given target scope. Default-deny. */
export function permissionsFor(bindings: readonly RoleBindingView[], target: ScopeRef): Set<Permission> {
  const granted = new Set<Permission>();
  for (const b of bindings) {
    if (!bindingCovers(b, target)) continue;
    for (const p of permissionsOfRole(b.role)) granted.add(p);
  }
  return granted;
}

export function can(bindings: readonly RoleBindingView[], target: ScopeRef, perm: Permission): boolean {
  return permissionsFor(bindings, target).has(perm);
}
